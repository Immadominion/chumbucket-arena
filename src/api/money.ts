/**
 * `money.*` — calls with an amount, the wallet sheet, cash out, winnings,
 * deposit options and gas. The contract is docs/money-api.md.
 *
 * Behind MONEY_CALLS_ENABLED (default off): off, every procedure but
 * `money.status` refuses with PRECONDITION_FAILED and nothing else changes.
 *
 * Every procedure is a POST mutation: the Supabase session rides in the
 * Authorization header and nothing private lands in a URL. The account comes
 * from the one resolver (src/auth/accountResolver.ts) through the deposits
 * accounts, never from input; a `wallet` input only selects among the
 * account's own proven wallets. Every message is our copy.
 */
import { TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";
import { callsRuntimeFor } from "../calls/runtime.ts";
import { isCallsError } from "../calls/errors.ts";
import type { FundedCallInput } from "../calls/CallsService.ts";
import type { AppConfig } from "../config.ts";
import type { DepositPerson } from "../deposits/accounts.ts";
import { NOT_LIVE_REASON, centsToUsd, depositsOpenTo } from "../deposits/config.ts";
import { depositsRuntimeFor } from "../deposits/runtime.ts";
import { collectableWinnings, buildActivity, solanaPayUri } from "../money/activity.ts";
import { isMoneyError, MoneyError, MONEY_OFF_COPY, type MoneyErrorCode } from "../money/errors.ts";
import { MONEY_MIN_BASE_UNITS, MONEY_PRESETS_BASE_UNITS, PENDING_TTL_MS } from "../money/MoneyCallsService.ts";
import { moneyRuntimeFor } from "../money/runtime.ts";
import { moneyCallsEnabled } from "../money/visibility.ts";
import { MAINNET_USDC_MINT } from "../prediction/PantaChain.ts";
import { pantaLifecycleFor, pantaTradingReadiness } from "../prediction/PantaTradingRuntime.ts";
import { isVenueError } from "../prediction/errors.ts";
import { isPgrestError } from "../prediction/pgrest.ts";
import { isTrustError } from "../trust/errors.ts";
import { trustRuntimeFor } from "../trust/runtime.ts";
import { chooseTradingWallet, chumbucketWalletEnabled } from "../wallet/tradingWallet.ts";
import { callsTrpcError, freshenPantaPrice } from "./calls.ts";
import { trustTrpcError } from "./trust.ts";
import type { Context } from "./trpc.ts";
import { publicProcedure, router } from "./trpc.ts";

const CODES: Record<MoneyErrorCode, TRPC_ERROR_CODE_KEY> = {
  DISABLED: "PRECONDITION_FAILED",
  SIGNED_OUT: "UNAUTHORIZED",
  NOT_LINKED: "FORBIDDEN",
  NO_WALLET: "PRECONDITION_FAILED",
  WALLET_NOT_LINKED: "UNPROCESSABLE_CONTENT",
  AMOUNT: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  STATE: "PRECONDITION_FAILED",
  IN_FLIGHT: "CONFLICT",
  IDEMPOTENCY_CONFLICT: "CONFLICT",
  MARKET_CLOSED: "PRECONDITION_FAILED",
  NOT_TRADABLE: "PRECONDITION_FAILED",
  PRICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  BAD_SIGNATURE: "BAD_REQUEST",
  EXPIRED: "PRECONDITION_FAILED",
  RATE_LIMITED: "TOO_MANY_REQUESTS",
  UNAVAILABLE: "SERVICE_UNAVAILABLE",
};

/** Per account, per minute. Money reads poll; writes are taps. */
const LIMITS = { write: 20, read: 90 } as const;
class MoneyRateLimiter {
  private readonly hits = new Map<string, number[]>();
  take(userId: string, kind: keyof typeof LIMITS): void {
    const now = Date.now();
    const key = `${userId}:${kind}`;
    const recent = (this.hits.get(key) ?? []).filter(t => t > now - 60_000);
    if (recent.length >= LIMITS[kind]) throw new MoneyError("RATE_LIMITED", "That's a lot of tries in a minute. Give it a moment and try again.");
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 20_000) this.hits.delete(this.hits.keys().next().value as string);
  }
}
const limiters = new WeakMap<AppConfig, MoneyRateLimiter>();
function limiter(config: AppConfig): MoneyRateLimiter {
  let held = limiters.get(config);
  if (!held) { held = new MoneyRateLimiter(); limiters.set(config, held); }
  return held;
}

function venueCode(code: string): TRPC_ERROR_CODE_KEY {
  switch (code) {
    case "FUNDED_POSITIONS_DISABLED": return "PRECONDITION_FAILED";
    case "IDEMPOTENCY_CONFLICT": return "CONFLICT";
    case "VENUE_NOT_FOUND": return "NOT_FOUND";
    case "VENUE_RATE_LIMITED": return "TOO_MANY_REQUESTS";
    case "VENUE_BAD_REQUEST": return "BAD_REQUEST";
    case "WALLET_NOT_LINKED": return "UNPROCESSABLE_CONTENT";
    default: return "BAD_GATEWAY";
  }
}

/** Our copy only; anything unexpected is a generic, causeless failure (rows can hold signed approvals). */
async function run<T>(procedure: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof TRPCError) throw error;
    if (isMoneyError(error)) throw new TRPCError({ code: CODES[error.code], message: error.message });
    if (isCallsError(error)) throw callsTrpcError(error);
    if (isTrustError(error)) throw trustTrpcError(error);
    if (isVenueError(error)) throw new TRPCError({ code: venueCode(error.code), message: error.message });
    if (isPgrestError(error)) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Money isn't available right now. Nothing was charged. Try again shortly." });
    console.warn("[money] failed", JSON.stringify({ procedure, error: error instanceof Error ? error.name : "unknown" }));
    throw new TRPCError({ code: "BAD_GATEWAY", message: "Something went wrong. Nothing was charged. Try again." });
  }
}

function requireOn(config: AppConfig): void {
  if (!moneyCallsEnabled(config)) throw new MoneyError("DISABLED", MONEY_OFF_COPY);
}

/** The account and its proven wallets, from the one resolver (via the deposits accounts). */
async function person(ctx: Context, kind: keyof typeof LIMITS): Promise<DepositPerson> {
  const resolved = await depositsRuntimeFor(ctx.app.config).accounts.resolve(ctx.supabaseAccessToken, { email: false });
  if (!resolved.ok) {
    if (resolved.reason === "SIGNED_OUT") throw new MoneyError("SIGNED_OUT", "Sign in to do that.");
    if (resolved.reason === "NOT_LINKED") throw new MoneyError("NOT_LINKED", "Finish setting up your account first.");
    throw new MoneyError("UNAVAILABLE", "We couldn't confirm your account just now. Try again in a moment.");
  }
  limiter(ctx.app.config).take(resolved.person.userId, kind);
  return resolved.person;
}

/** The calls mirror (and which calls are private) is read, and this person is in its directory. */
async function callsReady(config: AppConfig, userId: string) {
  const rt = callsRuntimeFor(config);
  await rt.ready;
  if (rt.durable && !rt.store.getPerson(userId)) await rt.durable.refreshPerson(userId);
  return rt;
}

function trading(config: AppConfig, who: DepositPerson) {
  return chooseTradingWallet(who, chumbucketWalletEnabled(config));
}

const baseUnits = z.string().regex(/^[1-9][0-9]{0,15}$/);
const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const uuid = z.string().uuid();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/);
const signedTransaction = z.string().min(1).max(1644);
const common = {
  amountBaseUnits: baseUnits,
  idempotencyKey,
  wallet: wallet.optional(),
  confidence: z.number().min(0).max(1).nullish(),
  thesis: z.string().max(280).nullish(),
  visibility: z.enum(["public", "followers"]).default("public"),
  maxSlippageBps: z.number().int().min(0).max(500).default(100),
};
const prepareInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("own"), marketId: z.string().min(1).max(256), side: z.enum(["YES", "NO"]), ...common }).strict(),
  z.object({ kind: z.literal("back"), targetCallId: z.string().min(1).max(256), ...common }).strict(),
  z.object({ kind: z.literal("fade"), targetCallId: z.string().min(1).max(256), ...common }).strict(),
]);
const none = z.object({}).strict().optional();

export const moneyRouter = router({
  /** Whether calls with money are on, the amounts, and (signed in) the default amount. */
  status: publicProcedure.input(none).mutation(({ ctx }) => run("money.status", async () => {
    const config = ctx.app.config;
    const on = moneyCallsEnabled(config);
    const panta = pantaTradingReadiness(config);
    const max = config.predictions?.maxAmountBaseUnits;
    let defaultAmountBaseUnits: string | null = null;
    if (on && ctx.supabaseAccessToken) {
      const resolved = await depositsRuntimeFor(config).accounts.resolve(ctx.supabaseAccessToken, { email: false }).catch(() => null);
      if (resolved?.ok) defaultAmountBaseUnits = await moneyRuntimeFor(config).calls.defaultAmount(resolved.person.userId).catch(() => null);
    }
    return {
      enabled: on && panta.enabled,
      reason: !on ? MONEY_OFF_COPY : panta.enabled ? null : "Calls with money are paused right now.",
      presetsBaseUnits: [...MONEY_PRESETS_BASE_UNITS],
      minBaseUnits: MONEY_MIN_BASE_UNITS.toString(),
      maxBaseUnits: max && /^[1-9][0-9]{0,15}$/.test(max) ? max : null,
      defaultAmountBaseUnits,
      pendingTtlMs: PENDING_TTL_MS,
    };
  })),

  /** A call with an amount: your own, or Tail (back) / Fade on someone else's. */
  prepareCall: publicProcedure.input(prepareInput).mutation(({ ctx, input }) => run("money.prepareCall", async () => {
    const config = ctx.app.config;
    requireOn(config);
    const who = await person(ctx, "write");
    const rt = await callsReady(config, who.userId);
    const trust = trustRuntimeFor(config).service;
    trust.assertClean(input.thesis, "thesis");
    let marketId: string | undefined;
    let call: FundedCallInput;
    if (input.kind === "own") {
      call = { kind: "own", marketId: input.marketId, side: input.side };
      marketId = input.marketId;
    } else {
      call = { kind: input.kind, targetCallId: input.targetCallId };
      const target = rt.store.getCall(input.targetCallId);
      if (target && target.userId !== who.userId) await trust.assertNotBlocked(who.userId, target.userId, "respond");
      marketId = target?.marketId;
    }
    // 18+ / jurisdiction / venue terms, recorded before the first funded trade.
    await trust.assertFundedTradingAccepted(who.userId);
    await freshenPantaPrice(rt, marketId);
    return moneyRuntimeFor(config).calls.prepareCall(who, {
      call, amountBaseUnits: input.amountBaseUnits, idempotencyKey: input.idempotencyKey, wallet: input.wallet,
      confidence: input.confidence ?? null, thesis: input.thesis ?? null, visibility: input.visibility, maxSlippageBps: input.maxSlippageBps,
    });
  })),

  /** The money call, its SUBMITTED order re-checked first. Polled. */
  callStatus: publicProcedure.input(z.object({ callId: uuid }).strict()).mutation(({ ctx, input }) => run("money.callStatus", async () => {
    requireOn(ctx.app.config);
    const who = await person(ctx, "read");
    await callsReady(ctx.app.config, who.userId);
    return moneyRuntimeFor(ctx.app.config).calls.status(who.userId, input.callId);
  })),

  /** A fresh quote for a pending call whose trade failed or whose quote expired. */
  retry: publicProcedure.input(z.object({ callId: uuid, wallet: wallet.optional() }).strict()).mutation(({ ctx, input }) => run("money.retry", async () => {
    const config = ctx.app.config;
    requireOn(config);
    const who = await person(ctx, "write");
    await callsReady(config, who.userId);
    await trustRuntimeFor(config).service.assertFundedTradingAccepted(who.userId);
    return moneyRuntimeFor(config).calls.retry(who, input.callId, input.wallet);
  })),

  /** Go free instead: the pending call is withdrawn and a fresh free call is made at the current price. */
  keepFree: publicProcedure.input(z.object({ callId: uuid }).strict()).mutation(({ ctx, input }) => run("money.keepFree", async () => {
    const config = ctx.app.config;
    requireOn(config);
    const who = await person(ctx, "write");
    const rt = await callsReady(config, who.userId);
    // The fresh free call is stamped with the current price: read it now, like calls.create does.
    const own = rt.store.getCall(input.callId);
    if (own && own.userId === who.userId) await freshenPantaPrice(rt, own.marketId);
    return moneyRuntimeFor(config).calls.keepFree(who.userId, input.callId);
  })),

  /** Drop a pending call for good: withdrawn, never shown. */
  discard: publicProcedure.input(z.object({ callId: uuid }).strict()).mutation(({ ctx, input }) => run("money.discard", async () => {
    requireOn(ctx.app.config);
    const who = await person(ctx, "write");
    await callsReady(ctx.app.config, who.userId);
    return moneyRuntimeFor(ctx.app.config).calls.discard(who.userId, input.callId);
  })),

  /** The account's pending money calls, so nothing is left as a ghost. */
  pending: publicProcedure.input(none).mutation(({ ctx }) => run("money.pending", async () => {
    requireOn(ctx.app.config);
    const who = await person(ctx, "read");
    await callsReady(ctx.app.config, who.userId);
    return moneyRuntimeFor(ctx.app.config).calls.pending(who.userId);
  })),

  /** The trading wallet's real balance (the header pill), and whether a top-up must run first. */
  wallet: publicProcedure.input(none).mutation(({ ctx }) => run("money.wallet", async () => {
    const config = ctx.app.config;
    requireOn(config);
    const who = await person(ctx, "read");
    const chosen = trading(config, who);
    if (!chosen) return { wallet: null, balance: null, gas: null };
    const balances = depositsRuntimeFor(config).balances;
    if (!balances) throw new MoneyError("UNAVAILABLE", "Balances aren't available on this server.");
    let balance: Awaited<ReturnType<typeof balances.read>>;
    try { balance = await balances.read(chosen.address); }
    catch { throw new MoneyError("UNAVAILABLE", "We couldn't read your balance just now. Try again in a moment."); }
    let gas: { needsTopUp: boolean; topUp: { amountBaseUnits: string } | null } | null = null;
    try {
      const answer = await moneyRuntimeFor(config).gas.forTrade(who, chosen.address, BigInt(balance.lamports));
      gas = answer.needsSol ? { needsTopUp: true, topUp: answer.topUp } : { needsTopUp: false, topUp: null };
    } catch { gas = null; }
    return {
      wallet: { address: chosen.address, walletType: chosen.walletType },
      balance: { usdcBaseUnits: balance.usdcBaseUnits, lamports: balance.lamports, slot: balance.slot },
      gas,
    };
  })),

  /** Recent money activity: trades, claims, deposits, cash outs. */
  activity: publicProcedure.input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict().optional())
    .mutation(({ ctx, input }) => run("money.activity", async () => {
      const config = ctx.app.config;
      requireOn(config);
      const who = await person(ctx, "read");
      const rt = await callsReady(config, who.userId);
      const money = moneyRuntimeFor(config);
      let life: ReturnType<typeof pantaLifecycleFor> | null = null;
      try { life = pantaLifecycleFor(config, true); } catch { life = null; }
      const chosen = trading(config, who);
      const [trades, claims, transfers, credits] = await Promise.all([
        life?.ledger ? life.ledger.listForUser(who.userId, 50) : Promise.resolve([]),
        life?.claimStore ? life.claimStore.listForUser(who.userId) : Promise.resolve([]),
        money.transfers.listForUser(who.userId, 50),
        // Chain-only deposits are left out when the RPC can't answer; ledger items always show.
        chosen && money.credits ? money.credits.recentCredits(chosen.address, 20).catch(() => []) : Promise.resolve([]),
      ]);
      return { items: buildActivity({ trades, claims, transfers, credits, market: id => rt.markets.getMarket(id), limit: input?.limit ?? 20 }) };
    })),

  /** Build a USDC transfer from the trading wallet to any wallet address. */
  cashOutPrepare: publicProcedure.input(z.object({ destination: z.string().min(1).max(64), amountBaseUnits: baseUnits, idempotencyKey }).strict())
    .mutation(({ ctx, input }) => run("money.cashOutPrepare", async () => {
      const config = ctx.app.config;
      requireOn(config);
      const who = await person(ctx, "write");
      const chosen = trading(config, who);
      if (!chosen) throw new MoneyError("NO_WALLET", "Set up your wallet first.");
      return moneyRuntimeFor(config).transfers.cashOut(who, chosen, input);
    })),

  /** Build a USDC transfer from one of your linked wallets into the trading wallet. */
  depositFromWalletPrepare: publicProcedure.input(z.object({ fromWallet: wallet, amountBaseUnits: baseUnits, idempotencyKey }).strict())
    .mutation(({ ctx, input }) => run("money.depositFromWalletPrepare", async () => {
      const config = ctx.app.config;
      requireOn(config);
      const who = await person(ctx, "write");
      const chosen = trading(config, who);
      if (!chosen) throw new MoneyError("NO_WALLET", "Set up your wallet first.");
      return moneyRuntimeFor(config).transfers.depositFromWallet(who, chosen, input);
    })),

  /** The owner-signed transfer: stored, then broadcast. SUBMITTED, never "done". */
  transferSubmit: publicProcedure.input(z.object({ transferId: uuid, signedTransaction }).strict())
    .mutation(({ ctx, input }) => run("money.transferSubmit", async () => {
      requireOn(ctx.app.config);
      const who = await person(ctx, "write");
      return moneyRuntimeFor(ctx.app.config).transfers.submit(who.userId, input.transferId, input.signedTransaction);
    })),

  /** One transfer, re-checked against the chain. Polled. */
  transferStatus: publicProcedure.input(z.object({ transferId: uuid }).strict())
    .mutation(({ ctx, input }) => run("money.transferStatus", async () => {
      requireOn(ctx.app.config);
      const who = await person(ctx, "read");
      return moneyRuntimeFor(ctx.app.config).transfers.status(who.userId, input.transferId);
    })),

  /** Won positions to collect, with amounts. Collect with pantaTrading.claimPrepare / claimSubmit / claim. */
  winnings: publicProcedure.input(none).mutation(({ ctx }) => run("money.winnings", async () => {
    const config = ctx.app.config;
    requireOn(config);
    const who = await person(ctx, "read");
    await callsReady(config, who.userId);
    let life: ReturnType<typeof pantaLifecycleFor> | null = null;
    try { life = pantaLifecycleFor(config, true); } catch { life = null; }
    // Without the claim ledger nothing can be collected here.
    if (!life?.positions || !life.claimStore) return { items: [], totalBaseUnits: "0" };
    return collectableWinnings(await life.positions.positions(who.userId));
  })),

  /** Every way to add funds, in one answer. */
  depositOptions: publicProcedure.input(z.object({ amountBaseUnits: baseUnits.optional() }).strict().optional())
    .mutation(({ ctx, input }) => run("money.depositOptions", async () => {
      const config = ctx.app.config;
      requireOn(config);
      const who = await person(ctx, "read");
      const deposits = depositsRuntimeFor(config);
      const chosen = trading(config, who);
      const open = depositsOpenTo(deposits.readiness, who.userId, deposits.admins);
      const cfg = open ? deposits.readiness.config : null;
      return {
        tradingWallet: chosen ? { address: chosen.address, walletType: chosen.walletType } : null,
        sendUsdc: chosen ? {
          address: chosen.address, mint: MAINNET_USDC_MINT, network: "solana-mainnet" as const,
          uri: solanaPayUri(chosen.address, MAINNET_USDC_MINT, input?.amountBaseUnits),
        } : null,
        card: {
          available: open,
          // Staging delivers devnet test USDC and is offered to admins only; it says test every time.
          testMode: cfg?.environment === "staging",
          reason: open ? null : (deposits.readiness.reason?.message ?? NOT_LIVE_REASON.message),
          presetsUsd: cfg ? cfg.presetsCents.map(centsToUsd) : [],
          limits: cfg ? { minUsd: centsToUsd(cfg.minOrderCents), maxUsd: centsToUsd(cfg.maxOrderCents) } : null,
        },
        fromWallet: {
          wallets: who.wallets.filter(w => w.address !== chosen?.address).map(w => ({ address: w.address, walletType: w.walletType })),
        },
      };
    })),
});
