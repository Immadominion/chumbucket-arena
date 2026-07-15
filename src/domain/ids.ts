/**
 * Branded identifiers and money units.
 *
 * Money is represented in FROST — the smallest unit staked in this game — as a
 * `bigint`, so the parimutuel maths never touches floating point. superjson
 * carries bigints across the tRPC boundary intact. On Solana the staked asset
 * is USDC (6 decimals), so FROST_PER_WAL is 1e6, not WAL's native 1e9 — the
 * name is kept internal/unchanged (see the plan: repoint, don't rename) since
 * it's an implementation detail no caller depends on the literal token for.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Wallet = Brand<string, "Wallet">; // Solana address, lower-cased
export type MatchId = Brand<string, "MatchId">;
export type MarketId = Brand<string, "MarketId">;
export type Bucket = Brand<string, "Bucket">;
export type CallId = Brand<string, "CallId">;
export type TakeId = Brand<string, "TakeId">;
export type VerdictId = Brand<string, "VerdictId">;
export type ChallengeId = Brand<string, "ChallengeId">;
export type EventId = Brand<string, "EventId">;

export const FROST_PER_WAL = 1_000_000n;
/** Money, in FROST. */
export type Frost = bigint;

// Digits in FROST_PER_WAL (6 for USDC's 1e6) — wal()/formatWal() pad/parse the
// fractional part to exactly this many digits. Derived, not hardcoded, so a
// future decimals change (a different staked asset) can't silently corrupt
// amounts the way a stale literal digit count would.
const FROST_DECIMALS = FROST_PER_WAL.toString().length - 1;

export const wal = (whole: number): Frost => {
  // Convert a human WAL figure to FROST without float drift on the fraction.
  const s = whole.toString();
  const dot = s.indexOf(".");
  const int = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  const fracPadded = (frac + "0".repeat(FROST_DECIMALS)).slice(0, FROST_DECIMALS);
  return BigInt(int) * FROST_PER_WAL + BigInt(fracPadded || "0");
};

export const formatWal = (frost: Frost): string => {
  const neg = frost < 0n;
  const abs = neg ? -frost : frost;
  const int = abs / FROST_PER_WAL;
  const frac = (abs % FROST_PER_WAL).toString().padStart(FROST_DECIMALS, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
};

// Solana base58 addresses are CASE-SENSITIVE — never lower-case them (that was a
// Sui carry-over; lower-casing silently derives a different, unspendable ATA and
// breaks deposit matching against canonical mixed-case chain data). Trim only.
export const asWallet = (s: string): Wallet => s.trim() as Wallet;
export const asMatchId = (s: string): MatchId => s as MatchId;
export const asMarketId = (s: string): MarketId => s as MarketId;
export const asBucket = (s: string): Bucket => s as Bucket;
export const asChallengeId = (s: string): ChallengeId => s as ChallengeId;
export const asCallId = (s: string): CallId => s as CallId;

export const newId = <T extends string>(prefix: string): Brand<string, T> =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}` as Brand<string, T>;

export const newWithdrawalId = (): string => newId<"EventId">("wd");
export const newCallId = () => newId<"CallId">("call");
export const newTakeId = () => newId<"TakeId">("take");
export const newVerdictId = () => newId<"VerdictId">("vdct");
export const newChallengeId = () => newId<"ChallengeId">("chg");
export const newEventId = () => newId<"EventId">("evt");

/** The per-player Walrus namespace — one player, one continuous owned memory. */
export const playerStream = (w: Wallet): string => `gaffer:${w}`;
/** Shared game state for a single fixture. */
export const matchStream = (m: MatchId): string => `gaffer:match:${m}`;
/** A single 1-v-1 challenge escrow — a private 2-party aggregate, one per challenge. */
export const challengeStream = (c: ChallengeId): string => `gaffer:challenge:${c}`;

// ── House liquidity wallets ──────────────────────────────────────────────────
// Synthetic "house" bettors that seed a match's pools so a real player always has
// a counterparty. They are real player streams (settlement treats them like
// anyone else) but are filtered out of the public leaderboards.
export const HOUSE_WALLET_PREFIX = "house:";
export const houseWallet = (i: number): Wallet => `${HOUSE_WALLET_PREFIX}bot:${i}` as Wallet;
export const isHouseWallet = (w: Wallet): boolean => w.startsWith(HOUSE_WALLET_PREFIX);
