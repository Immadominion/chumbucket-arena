/**
 * Server-side reads from the public calls BFF, for the shareable /c, /u and /m
 * pages and the home page. Public queries only: no session, no wallet, no
 * cookie is ever forwarded, so a page shows exactly what a signed-out person
 * may see (public calls; followers-only calls never appear).
 *
 * tRPC over plain GET (`?input={"json":…}`), the same wire the app uses, with
 * short revalidation so a resolved receipt shows up within a minute without
 * every visit costing a round trip to Railway.
 */

export const CALLS_BFF_URL = (
  process.env.CALLS_BFF_URL ??
  process.env.NEXT_PUBLIC_CALLS_BFF_URL ??
  "https://chumbucket-calls-bff-production.up.railway.app"
).replace(/\/+$/, "");

// ── wire shapes (src/calls/types.ts, read-only subset) ──────────────────────

export type Side = "YES" | "NO";
export type CallOutcome = "PENDING" | "CORRECT" | "INCORRECT" | "VOID";
export type MarketStatus = "OPEN" | "CLOSED" | "RESOLVED" | "VOID" | string;

export interface SharePrice {
  venue: string;
  currency: string;
  unit: string;
  yesPrice: string | null;
  noPrice: string | null;
  observedAt: number;
  attribution: string | null;
}

export interface Market {
  id: string;
  venue: string;
  /** The market's quote asset. Panta markets are USDC or SOL; null/absent on older servers (USDC only). */
  quoteCurrency?: "USDC" | "SOL" | null;
  /** Whether Chumbucket can trade it. A SOL-quoted market takes calls only. */
  tradable?: boolean;
  venueMarketId: string | null;
  question: string;
  rulesText: string | null;
  category: string | null;
  outcomes: Array<{ side: Side; label: string }>;
  status: MarketStatus;
  closesAt: number | null;
  resolvesAt: number | null;
}

export interface Person {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** The app's preset picture (1..5) when the person picked one instead of a photo. */
  avatarId?: number | null;
  settledCalls: number;
  correctCalls: number;
}

/** A person as the people.* queries return them (no call counts). */
export interface PersonRef {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  avatarId?: number | null;
}

/** Counts behind a record: only calls the venue decided are right or wrong. */
export interface RecordCounts {
  correct: number;
  incorrect: number;
  voided: number;
  resolved: number;
  decided: number;
  pending: number;
}

export interface LeaderboardRow {
  rank: number | null;
  person: PersonRef;
  record: { counts: RecordCounts };
}

/** people.leaderboard: `ranked` have enough decided calls for a percentage, `building` not yet. */
export interface Leaderboard {
  window: string;
  ranked: LeaderboardRow[];
  building: LeaderboardRow[];
  minimumDecided: number;
}

/** people.suggested (signed out): people worth following, with their records. */
export interface Suggested {
  people: Array<PersonRef & { record?: { counts: RecordCounts } | null }>;
}

export interface Call {
  id: string;
  userId: string;
  marketId: string;
  side: Side;
  confidence: number | null;
  thesis: string | null;
  entryPrice?: SharePrice | null;
  visibility: "public" | "followers";
  createdAt: number;
  lockedAt: number;
  parentCallId: string | null;
  fundingState: string;
}

export interface CallResult {
  callId: string;
  outcome: CallOutcome;
  resolution: Side | "VOID" | null;
  resolvedAt: number | null;
}

export interface CallFeedEntry {
  call: Call;
  author: Person;
  market: Market;
  result: CallResult | null;
  backCount: number;
  fadeCount: number;
  /**
   * Set only when Panta confirmed a fill behind this call. With calls with
   * money on, it also carries the filled amount (USDC base units) and side.
   */
  funding?: { state?: string; venue?: string; amountBaseUnits?: string; side?: Side } | null;
}

export interface CallDetail {
  entry: CallFeedEntry;
  parent: CallFeedEntry | null;
  responses: Array<{ id: string; kind: "back" | "fade" | "challenge"; createdAt: number }>;
}

export interface PersonDetail {
  person: Person;
  calls: CallFeedEntry[];
}

export interface MarketDetail {
  market: Market;
  sharePrice?: SharePrice | null;
}

// ── the fetch ────────────────────────────────────────────────────────────────

/** The BFF answered "no such thing" (or "not visible to a stranger"). */
export class NotFound extends Error {}
/** The BFF could not be reached or failed. The page shows a retry state. */
export class Unavailable extends Error {}

async function query<T>(path: string, input: unknown, revalidate: number): Promise<T> {
  const url = `${CALLS_BFF_URL}/${path}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  let res: Response;
  try {
    // `next` is Next.js's fetch extension (ISR); cast so the module also
    // type-checks outside Next (the BFF repo's bun tests import it).
    res = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate },
      signal: AbortSignal.timeout(8_000),
    } as RequestInit);
  } catch {
    throw new Unavailable(path);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Unavailable(path);
  }
  const err = (body as { error?: { json?: { data?: { code?: string } } } })?.error;
  if (err) {
    const code = err.json?.data?.code;
    if (code === "NOT_FOUND" || code === "BAD_REQUEST") throw new NotFound(path);
    throw new Unavailable(path);
  }
  const data = (body as { result?: { data?: { json?: T } } })?.result?.data?.json;
  if (data === undefined || data === null) throw new NotFound(path);
  return data;
}

export const getCall = (callId: string) => query<CallDetail>("calls.get", { callId }, 60);
export const getPerson = (personRef: string) =>
  query<PersonDetail>("people.get", { personRef: personRef.replace(/^@/, "") }, 60);
export const getMarket = (marketId: string) => query<MarketDetail>("markets.detail", { marketId }, 60);
export const getFeed = (limit = 6) =>
  query<{ entries: CallFeedEntry[] }>("calls.feed", { mode: "global", limit }, 60);
export const getOpenMarkets = () => query<Market[]>("markets.open", {}, 300);
/** Records move only when Panta settles a market, so five minutes is fresh enough. */
export const getLeaderboard = () => query<Leaderboard>("people.leaderboard", {}, 300);
export const getSuggested = () => query<Suggested>("people.suggested", {}, 300);

/** Safe-to-call wrapper for optional page sections: null on any failure. */
export async function maybe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

// ── presentation helpers (pure) ──────────────────────────────────────────────

/**
 * One side's price read alone as a percent: `0.62` -> "62%". Only for a price
 * with nothing to weigh it against (its pair unpublished); a market's two
 * sides go through `pairPercent`, so they always add up.
 *
 * Whole percent, rounded half-up on the decimal string (no float drift). A
 * live price under half a percent reads "<1%" and one at 99.5% or more ">99%",
 * so an open market never reads as certain. Missing, negative, above 1 or
 * unparsable -> null.
 */
export function percentLabel(price: string | null | undefined): string | null {
  const m = typeof price === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(price.trim()) : null;
  if (!m) return null;
  const whole = Number(m[1]);
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  if (whole > 1 || (whole === 1 && fraction)) return null;
  if (whole === 1) return "100%";
  if (!fraction) return "0%";
  const tenths = Number(fraction.padEnd(3, "0").slice(0, 3)); // tenths of a percent, truncated
  if (tenths < 5) return "<1%";
  if (tenths >= 995) return ">99%";
  return `${Math.floor((tenths + 5) / 10)}%`;
}

/** A plain decimal as [digits, decimal places]; null if it is not one. */
function decimalParts(value: string | null | undefined): [bigint, number] | null {
  const m = typeof value === "string" ? /^(\d+)(?:\.(\d+))?$/.exec(value.trim()) : null;
  if (!m) return null;
  const fraction = m[2] ?? "";
  return [BigInt(`${m[1]}${fraction}`), fraction.length];
}

/**
 * A market's two sides as percents that always add up to 100. Panta's USDC
 * prices are independent venue prices: they need not sum to 1, and either can
 * exceed 1 (YES 1.25 / NO 0.35). So YES reads yes / (yes + no) and NO reads
 * 100 minus that rounded YES; a SOL market's complementary pair
 * (`last_yes_price` / 1e9 and its complement, src/prediction/PantaProgram.ts)
 * reads exactly as its own figures. Exact integer arithmetic, half-up; "<1%" /
 * ">99%" at the ends. A side alone (its pair unpublished) reads as itself
 * (`percentLabel`); both missing, or both zero, read null.
 */
export function pairPercent(
  yes: string | null | undefined,
  no: string | null | undefined,
): { yes: string | null; no: string | null } {
  const y = decimalParts(yes);
  const n = decimalParts(no);
  if (!y || !n) return { yes: y ? percentLabel(yes) : null, no: n ? percentLabel(no) : null };
  const places = Math.max(y[1], n[1]);
  const ys = y[0] * 10n ** BigInt(places - y[1]);
  const ns = n[0] * 10n ** BigInt(places - n[1]);
  const sum = ys + ns;
  if (sum === 0n) return { yes: null, no: null };
  // round(100 · yes / sum), half-up: floor((200 · yes + sum) / (2 · sum)).
  const pct = Number((ys * 200n + sum) / (sum * 2n));
  if (pct === 0 && ys > 0n) return { yes: "<1%", no: ">99%" };
  if (pct === 100 && ns > 0n) return { yes: ">99%", no: "<1%" };
  return { yes: `${pct}%`, no: `${100 - pct}%` };
}

/** One side's percent out of a market's price, weighed against the other. */
export function sidePercent(
  price: Pick<SharePrice, "yesPrice" | "noPrice"> | null | undefined,
  side: Side,
): string | null {
  if (!price) return null;
  const pair = pairPercent(price.yesPrice, price.noPrice);
  return side === "YES" ? pair.yes : pair.no;
}

/** The percent a call was made at, for its own side ("59%"), or null. */
export function entryPercent(call: {
  side: Side;
  entryPrice?: Pick<SharePrice, "yesPrice" | "noPrice"> | null;
}): string | null {
  return sidePercent(call.entryPrice, call.side);
}

export function sideLabel(market: Market, side: Side): string {
  return market.outcomes.find((o) => o.side === side)?.label ?? (side === "YES" ? "Yes" : "No");
}

export function outcomeCopy(result: CallResult | null): { label: string; tone: "pending" | "won" | "lost" | "void" } {
  switch (result?.outcome) {
    // Same words as the app's receipt badges (call_badges.dart).
    case "CORRECT":
      return { label: "Correct", tone: "won" };
    case "INCORRECT":
      return { label: "Incorrect", tone: "lost" };
    case "VOID":
      return { label: "Void", tone: "void" };
    default:
      return { label: "Pending", tone: "pending" };
  }
}

export function statusCopy(status: MarketStatus): string {
  switch (status) {
    case "OPEN":
      return "Open";
    case "CLOSED":
      return "Closed, awaiting result";
    case "RESOLVED":
      return "Resolved";
    case "VOID":
      return "Void";
    default:
      return String(status).toLowerCase();
  }
}

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export function whenLabel(ms: number | null | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return dateFmt.format(new Date(ms));
}

/** Where the venue shows this market. Panta only today. */
export function venueUrl(market: Market): string | null {
  if (market.venue === "panta" && market.venueMarketId) {
    return `https://panta.market/market/${encodeURIComponent(market.venueMarketId)}`;
  }
  return null;
}

/**
 * Whether the page may label this call "free". Only a call the BFF reports as
 * unfunded (`NONE`, or no state at all on an older payload) qualifies; any
 * funding state, even one that is not money yet, is never called free.
 */
export function isFreeCall(call: Pick<Call, "fundingState">): boolean {
  return !call.fundingState || call.fundingState === "NONE";
}

/**
 * The one money mark a call carries: `free` for an unfunded call, `funded`
 * only for a fill Panta confirmed, and nothing for anything in between (a
 * quote or a submitted order is neither free nor money in).
 */
export function callMark(entry: { call: Pick<Call, "fundingState">; funding?: unknown }): "free" | "funded" | null {
  if (entry.funding || entry.call.fundingState === "FILLED") return "funded";
  return isFreeCall(entry.call) ? "free" : null;
}

/**
 * A funded call's stamp, "$5 on YES", when the BFF sends the filled amount
 * and side; null otherwise (the mark then just says Funded). Dollars only,
 * rounded down to the cent.
 */
export function fundedLabel(entry: { funding?: CallFeedEntry["funding"]; market?: Pick<Market, "outcomes"> }): string | null {
  const f = entry.funding;
  if (!f || (f.state !== undefined && f.state !== "FILLED")) return null;
  if (!f.amountBaseUnits || !/^[1-9][0-9]{0,15}$/.test(f.amountBaseUnits) || (f.side !== "YES" && f.side !== "NO")) return null;
  // Below $1 a fill earns no stamp (the BFF sends no amount then either).
  if (BigInt(f.amountBaseUnits) < 1_000_000n) return null;
  const cents = BigInt(f.amountBaseUnits) / 10_000n;
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const amount = cents % 100n === 0n ? `$${dollars}` : `$${dollars}.${(cents % 100n).toString().padStart(2, "0")}`;
  const label = entry.market?.outcomes.find((o) => o.side === f.side)?.label;
  return `${amount} on ${label && label.toUpperCase() !== f.side ? label : f.side}`;
}

export function recordLabel(p: Person): string {
  if (p.settledCalls === 0) return "No settled calls yet";
  return `${p.correctCalls} of ${p.settledCalls} settled calls right`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** The app's preset pictures, mirrored from the mobile repo into public/img/profile. */
const PRESET_AVATARS = 5;

/**
 * What to show for a person, as the app decides it (avatar_catalog.dart's
 * avatarImageFor): their own https picture (X or Google, when they signed in
 * with one), else the preset picture they chose, else null for initials.
 */
export function avatarSrc(person: { avatarUrl: string | null; avatarId?: number | null }): string | null {
  const own = safeAvatar(person.avatarUrl);
  if (own) return own;
  const id = person.avatarId;
  return typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= PRESET_AVATARS ? `/img/profile/${id}.png` : null;
}

/** Only https avatars are rendered; anything else falls back to initials. */
export function safeAvatar(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
