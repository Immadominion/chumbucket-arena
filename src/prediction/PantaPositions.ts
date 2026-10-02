/**
 * The signed-in person's funded Panta positions, one row per funded call.
 *
 * Sources, and what each is trusted for:
 *  - the private intent ledger: what was bought, by which wallet, for which
 *    call, at what cost. Cost is the exact USDC debit RPC proved at fill.
 *  - Panta's quoted shares for that buy (`expectedShares` from the reviewed
 *    build). Panta's public API reports holdings per wallet, not per order, so
 *    this is the honest per-call figure; `walletShares` shows the wallet total.
 *  - the venue result mirror (`market_resolutions`): won / lost / void.
 *  - Panta `GET /positions/`: claim eligibility (`claimable`, `claimed`).
 *  - the latest captured Panta share price: mark-to-market while open.
 *
 * Every money figure is integer USDC base units as a string. Prices and share
 * counts are decimal strings. Nothing is estimated where a source is missing:
 * the figure is null and the app says so.
 */
import type { SharePriceSnapshot } from "./sharePrices.ts";
import type { MarketResolutionRecord, Side, VenueMarket } from "./types.ts";
import type { PantaHolding, PantaHoldingsReader } from "./PantaHoldings.ts";
import type { PantaClaimSession, PantaClaimStore } from "./PantaClaimStore.ts";
import type { PantaTradeSession, PantaTradingLedger } from "./PantaTradingStore.ts";

export type PantaPositionStatus =
  | "pending" | "failed" | "open" | "awaiting_result"
  | "won_claimable" | "won" | "claiming" | "claimed" | "lost" | "void";

export interface PantaPositionClaim {
  claimId: string;
  state: "SUBMITTED" | "CONFIRMED" | "FAILED";
  signature: string | null;
  payoutBaseUnits: string | null;
}
export interface PantaPosition {
  orderId: string;
  callId: string;
  marketId: string;
  venueMarketId: string;
  question: string | null;
  side: Side;
  owner: string;
  status: PantaPositionStatus;
  costBaseUnits: string;
  shares: string | null;
  /** All-in USDC per share: cost (fee included) divided by shares. */
  entryPrice: string | null;
  currentPrice: string | null;
  priceObservedAt: number | null;
  valueBaseUnits: string | null;
  pnlBaseUnits: string | null;
  walletShares: string | null;
  claim: PantaPositionClaim | null;
  pantaUrl: string;
  submittedAt: number;
  filledAt: number | null;
  fillTxSignature: string | null;
}
export interface PantaPositionsPage {
  positions: PantaPosition[];
  totals: { costBaseUnits: string; valueBaseUnits: string; pnlBaseUnits: string; counted: number };
  /** live: Panta answered for every wallet; unavailable: claim eligibility may be stale; none: no wallets. */
  holdings: "live" | "unavailable" | "none";
  /** Panta's public API has no sell or close endpoint. Selling happens on panta.market. */
  sell: { supported: false; reason: string };
  servedAt: number;
  attribution: "Powered by Panta";
}

export const pantaMarketUrl = (venueMarketId: string): string =>
  `https://panta.market/market/${encodeURIComponent(venueMarketId)}`;

// ── exact decimal arithmetic (1e18 fixed point, BigInt only) ────────────────
const SCALE = 10n ** 18n;
const DECIMAL = /^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/;
export function toFixed18(value: string): bigint | null {
  if (!DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(18, "0"));
}
export function fromFixed18(value: bigint, places = 6): string {
  const negative = value < 0n, abs = negative ? -value : value;
  const unit = 10n ** BigInt(18 - places);
  const rounded = (abs + unit / 2n) / unit; // half-up at `places`
  const whole = rounded / 10n ** BigInt(places), fraction = (rounded % 10n ** BigInt(places)).toString().padStart(places, "0").replace(/0+$/, "");
  return `${negative && rounded !== 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
/** shares x price, both decimals, in USDC base units (rounded down). */
export function valueBaseUnits(shares: string, price: string): bigint | null {
  const s = toFixed18(shares), p = toFixed18(price);
  if (s === null || p === null) return null;
  return (s * p) / 10n ** 30n;
}
/** cost (base units) / shares -> USDC per share. */
export function perShare(costBaseUnits: string, shares: string): string | null {
  const s = toFixed18(shares);
  if (s === null || s === 0n || !/^[0-9]+$/.test(costBaseUnits)) return null;
  return fromFixed18((BigInt(costBaseUnits) * 10n ** 12n * SCALE) / s);
}

export interface PantaPositionsDeps {
  ledger: Pick<PantaTradingLedger, "listForUser">;
  claims: Pick<PantaClaimStore, "listForUser"> | null;
  markets: {
    getMarket(marketId: string): VenueMarket | undefined;
    latestSharePrice?(marketId: string): SharePriceSnapshot | undefined;
    getResolution(marketId: string): MarketResolutionRecord | undefined;
  };
  holdings: PantaHoldingsReader | null;
  now?: () => number;
}

const FAILED_VISIBLE_MS = 7 * 24 * 3600_000;

export class PantaPositionsService {
  constructor(private readonly deps: PantaPositionsDeps) {}
  private now() { return this.deps.now?.() ?? Date.now(); }

  async positions(userId: string): Promise<PantaPositionsPage> {
    const now = this.now();
    const rows = (await this.deps.ledger.listForUser(userId)).filter(r =>
      r.prepared && r.signature && (r.state !== "FAILED" || now - Date.parse(r.updated_at) < FAILED_VISIBLE_MS));
    const claims = this.deps.claims ? await this.deps.claims.listForUser(userId) : [];
    const wallets = [...new Set(rows.filter(r => r.state === "FILLED").map(r => r.wallet_address))];
    const held = new Map<string, PantaHolding[] | null>();
    await Promise.all(wallets.map(async w => { held.set(w, this.deps.holdings ? await this.deps.holdings.holdings(w) : null); }));
    const positions = rows.map(row => this.position(row, claims, held.get(row.wallet_address) ?? null, now));
    let cost = 0n, value = 0n, counted = 0;
    for (const p of positions) {
      if (p.valueBaseUnits === null || ["pending", "failed"].includes(p.status)) continue;
      cost += BigInt(p.costBaseUnits); value += BigInt(p.valueBaseUnits); counted++;
    }
    return {
      positions,
      totals: { costBaseUnits: cost.toString(), valueBaseUnits: value.toString(), pnlBaseUnits: (value - cost).toString(), counted },
      holdings: wallets.length === 0 ? "none" : wallets.every(w => held.get(w) !== null) ? "live" : "unavailable",
      sell: { supported: false, reason: "Panta's public API has no sell or close order. Manage this position on panta.market." },
      servedAt: now,
      attribution: "Powered by Panta",
    };
  }

  private position(row: PantaTradeSession, claims: PantaClaimSession[], holdings: PantaHolding[] | null, now: number): PantaPosition {
    const market = this.deps.markets.getMarket(row.market_id);
    const shares = row.prepared!.review.expectedShares ?? null;
    const cost = String(row.amount_base_units);
    const holding = holdings?.find(h => h.venueMarketId === row.venue_market_id && h.side === row.side) ?? null;
    const claimRow = claims.find(c => c.wallet_address === row.wallet_address && c.venue_market_id === row.venue_market_id &&
      (c.state === "SUBMITTED" || c.state === "CONFIRMED")) ??
      claims.find(c => c.wallet_address === row.wallet_address && c.venue_market_id === row.venue_market_id && c.state === "FAILED") ?? null;
    const claim: PantaPositionClaim | null = claimRow && claimRow.state !== "PREPARING" && claimRow.state !== "BUILT" ? {
      claimId: claimRow.id, state: claimRow.state, signature: claimRow.signature,
      payoutBaseUnits: claimRow.state === "CONFIRMED" ? claimRow.confirm_evidence?.payoutBaseUnits ?? null : null } : null;

    let status: PantaPositionStatus;
    let price: string | null = null, observedAt: number | null = null;
    if (row.state === "SUBMITTED") status = "pending";
    else if (row.state === "FAILED") status = "failed";
    else {
      const resolution = this.deps.markets.getResolution(row.market_id)?.resolution ?? holding?.outcome ?? null;
      if (resolution === null) {
        if (holding?.phase === "cancelled") status = "void";
        else {
          const open = market?.status === "OPEN" && (market.closesAt === null || market.closesAt > now);
          status = open ? "open" : "awaiting_result";
          const snap = this.deps.markets.latestSharePrice?.(row.market_id);
          const side = snap ? (row.side === "YES" ? snap.yesPrice : snap.noPrice) : null;
          if (snap && side !== null) { price = side; observedAt = snap.observedAt; }
        }
      } else if (resolution === "VOID") status = "void";
      else if (resolution === row.side) {
        price = "1";
        if (claim?.state === "CONFIRMED" || holding?.claimed === true) status = "claimed";
        else if (claim?.state === "SUBMITTED") status = "claiming";
        else status = holding?.claimable === true ? "won_claimable" : "won";
      } else { status = "lost"; price = "0"; }
    }
    const value = shares !== null && price !== null ? valueBaseUnits(shares, price) : null;
    const fill = row.state === "FILLED" ? row.fill_evidence : null;
    return {
      orderId: row.provider_order_id!, callId: row.call_id, marketId: row.market_id, venueMarketId: row.venue_market_id,
      question: market?.question ?? null, side: row.side, owner: row.wallet_address, status,
      costBaseUnits: cost, shares, entryPrice: shares === null ? null : perShare(cost, shares),
      currentPrice: price, priceObservedAt: observedAt,
      valueBaseUnits: value === null ? null : value.toString(),
      pnlBaseUnits: value === null ? null : (value - BigInt(cost)).toString(),
      walletShares: holding?.shares ?? null, claim,
      pantaUrl: pantaMarketUrl(row.venue_market_id),
      submittedAt: Date.parse(row.created_at),
      filledAt: fill ? Date.parse(row.updated_at) : null,
      fillTxSignature: fill?.fillTxSignature ?? null,
    };
  }
}
