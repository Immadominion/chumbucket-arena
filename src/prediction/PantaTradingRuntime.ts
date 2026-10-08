/** Native Panta composition. Production never falls back to memory or DevAuth. */
import { PublicKey } from "@solana/web3.js";
import type { AppConfig } from "../config.ts";
import { PantaVenue } from "./PantaVenue.ts";
import { PantaExecution } from "./PantaExecution.ts";
import { PantaChain } from "./PantaChain.ts";
import { pantaPost } from "./PantaHttp.ts";
import { SupabasePantaTradingStore, type PantaTradingLedger } from "./PantaTradingStore.ts";
import { SupabasePantaClaimStore, type PantaClaimStore } from "./PantaClaimStore.ts";
import { PantaClaimExecution } from "./PantaClaims.ts";
import { PantaClaimService } from "./PantaClaimService.ts";
import { PantaFundingIndex, pantaFundingIndexFor } from "./PantaFunding.ts";
import { PantaHoldings } from "./PantaHoldings.ts";
import { PantaPositionsService } from "./PantaPositions.ts";
import { PantaReconciler } from "./PantaReconciler.ts";
import { PantaSettlementChain } from "./PantaSettlementChain.ts";
import { callsRuntimeFor } from "../calls/runtime.ts";
import { predictionRuntimeFor } from "./runtime.ts";
import { PantaTradingService } from "./PantaTradingService.ts";
import { SupabaseAccountWallets } from "../wallet/accountWallets.ts";
import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";
import { PgrestError } from "./pgrest.ts";
import { moneyHooksFor, notifyMoneyFill } from "../money/hooks.ts";
import { moneyCallsRollout, rolloutActive } from "../rollout.ts";
import { VenueError } from "./errors.ts";

/** Independently checked as the executable mainnet owner of a live Panta market. */
export const PANTA_MAINNET_PROGRAM_ID = "6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp";

export function pantaTradingReadiness(config: AppConfig, forRead = false): { enabled: boolean; reason: string | null; venue: "panta"; attribution: "Powered by Panta" } {
  let reason: string | null = null;
  if (!forRead && config.predictions?.flags?.fundedPositions !== true) reason = "Panta trading is paused by the server emergency switch";
  else if (config.predictions?.venue !== "panta" || !config.predictions.panta?.apiKey?.startsWith("pk_live_")) reason = "A live server-held Panta key is required";
  // People and the existing follow graph are not Solana-network identities.
  // Preserve the deployed social namespace; PantaChain independently pins the
  // RPC genesis before every broadcast/confirmation to enforce mainnet.
  else if (!config.social) reason = "A durable account database is required";
  else if (config.predictions.pantaSchemaReady !== true) reason = "The Panta native-price and intent-ledger migrations must be verified";
  else if (!/^usr_[A-Za-z0-9_-]{1,100}$/.test(config.predictions.panta?.partnerUserId ?? "")) reason = "The key-bound Panta partner attribution account must be verified";
  else {
    try {
      if (new PublicKey(config.predictions.panta!.programId ?? "").toBase58() !== PANTA_MAINNET_PROGRAM_ID) throw new Error();
    }
    catch { reason = "The verified Panta mainnet program must be pinned"; }
    if (!/^[1-9][0-9]{0,15}$/.test(config.predictions.maxAmountBaseUnits ?? "")) reason = "The per-approval USDC limit must be configured";
  }
  return { enabled: reason === null, reason, venue: "panta", attribution: "Powered by Panta" };
}

/** The claim ledger migration is applied in this environment (owner-set). */
export function pantaClaimsSchemaReady(env: Record<string, string | undefined> = process.env): boolean {
  return env.PANTA_CLAIM_SCHEMA_READY === "true";
}

/** Everything the funded lifecycle needs, built once per AppConfig. */
export interface PantaLifecycle {
  trading: PantaTradingService;
  claims: PantaClaimService | null;
  positions: PantaPositionsService | null;
  holdings: PantaHoldings | null;
  ledger: PantaTradingLedger | null;
  claimStore: PantaClaimStore | null;
  funding: PantaFundingIndex;
}
const runtimes = new WeakMap<AppConfig, PantaTradingService>();
const lifecycles = new WeakMap<AppConfig, PantaLifecycle>();

function buildLifecycle(config: AppConfig): PantaLifecycle {
  const panta = config.predictions!.panta!;
  const chain = new PantaChain(config.solana.rpcUrl);
  const settlement = new PantaSettlementChain(config.solana.rpcUrl);
  // This dedicated durable transport does not propagate native exception causes
  // or database error details containing a signed approval to logs/responses.
  const safeFetch: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (res.ok) return res;
      return new Response(JSON.stringify({ message: "Panta ledger refused the operation" }), { status: res.status });
    } catch { throw new PgrestError("Panta durable ledger request did not complete"); }
  }, { preconnect: fetch.preconnect });
  const request = pantaPost(panta.apiKey, panta.timeoutMs);
  const execution = new PantaExecution({ request, programId: panta.programId!, providerUserId: panta.partnerUserId!, verifyTransaction: input => chain.verifyTransaction(input) });
  const ledger = new SupabasePantaTradingStore(config.social!, safeFetch, { moneyCalls: rolloutActive(moneyCallsRollout(config)) });
  // Claims need 20261002170000_panta_claim_sessions.sql. Until the owner has
  // applied it and said so, claims answer "not configured" and the app links
  // to panta.market instead; positions and reconciliation of buys still work.
  const claimStore = pantaClaimsSchemaReady() ? new SupabasePantaClaimStore(config.social!, safeFetch) : null;
  const funding = pantaFundingIndexFor(config);
  const holdings = new PantaHoldings({ apiKey: panta.apiKey, timeoutMs: panta.timeoutMs });
  const trading = new PantaTradingService({
    store: ledger, execution,
    chain: { broadcast: tx => chain.broadcast(tx), failed: sig => chain.failed(sig),
      neverLanded: (sig, height) => settlement.neverLanded(sig, height) },
    // The catalog's program reader: without it no USDC row (Panta dropped
    // `onChain` on 2026-10-08) has rules, and every buy would be refused.
    venue: new PantaVenue({ apiKey: panta.apiKey, timeoutMs: panta.timeoutMs, ...predictionRuntimeFor(config).pantaProgram }),
    maxAmountBaseUnits: config.predictions!.maxAmountBaseUnits!,
    // A buy is only ever quoted for one of the account's own proven wallets,
    // and never for one that signs in to another account (linking).
    wallets: new SupabaseAccountWallets(config.social!, fetch, authIdentityRuntimeFor(config).accountLinks),
    onFilled: row => {
      funding.markFilled(row.call_id, Date.parse(row.updated_at), { id: row.id, amountBaseUnits: String(row.amount_base_units), side: row.side });
      holdings.forget(row.wallet_address);
      // A pending money call becomes FUNDED (docs/money-api.md). No-op with money calls off.
      notifyMoneyFill(config, row);
    },
  });
  const claims = claimStore && new PantaClaimService({
    claims: claimStore, trades: ledger,
    execution: new PantaClaimExecution({ request, programId: panta.programId! }),
    chain: { broadcast: tx => chain.broadcast(tx), failed: sig => chain.failed(sig),
      neverLanded: (sig, height) => settlement.neverLanded(sig, height), verifyClaim: input => settlement.verifyClaim(input) },
    report: body => request("/trades/", body),
  });
  const markets = callsRuntimeFor(config).markets;
  const positions = new PantaPositionsService({ ledger, claims: claimStore, markets, holdings });
  return { trading, claims, positions, holdings, ledger, claimStore, funding };
}

/** The whole funded lifecycle. Reads (`forRead`) keep working while new approvals are paused. */
export function pantaLifecycleFor(config: AppConfig, forRead = false): PantaLifecycle {
  const ready = pantaTradingReadiness(config, forRead);
  if (!ready.enabled) throw new VenueError("FUNDED_POSITIONS_DISABLED", ready.reason!, { venue: "panta" });
  const held = lifecycles.get(config); if (held) return held;
  const pinned = runtimes.get(config);
  const lifecycle = pinned
    // A test-pinned trading service has no durable lifecycle beside it.
    ? { trading: pinned, claims: null, positions: null, holdings: null, ledger: null, claimStore: null, funding: pantaFundingIndexFor(config) }
    : buildLifecycle(config);
  lifecycles.set(config, lifecycle); return lifecycle;
}
export function pantaTradingFor(config: AppConfig, forRead = false): PantaTradingService {
  const ready = pantaTradingReadiness(config, forRead);
  if (!ready.enabled) throw new VenueError("FUNDED_POSITIONS_DISABLED", ready.reason!, { venue: "panta" });
  return runtimes.get(config) ?? pantaLifecycleFor(config, forRead).trading;
}
/** The server reconciler over the same lifecycle. Read-only readiness: pausing new approvals never stops reconciliation. */
export function pantaReconcilerFor(config: AppConfig, opts: { maxPerPass?: number } = {}): PantaReconciler {
  const life = pantaLifecycleFor(config, true);
  return new PantaReconciler({ ledger: life.ledger ?? { submitted: async () => [] }, trading: life.trading,
    claimStore: life.claimStore, claims: life.claims, funding: life.funding,
    // MONEY_CALLS_ENABLED: expire abandoned pending calls, repair FUNDED, settle transfers.
    money: rolloutActive(moneyCallsRollout(config)) ? {
      sweep: async () => {
        const hooks = moneyHooksFor(config);
        return hooks ? hooks.sweep() : { funded: 0, expired: 0, transfersConfirmed: 0, transfersFailed: 0, errors: [] };
      },
    } : null,
    ...opts });
}
/** Test seam, scoped to the exact AppConfig object. Never selected by env. */
export function setPantaTradingRuntime(config: AppConfig, service: PantaTradingService): void { runtimes.set(config, service); lifecycles.delete(config); }
/** Test seam for the whole lifecycle, scoped to the exact AppConfig object. */
export function setPantaLifecycle(config: AppConfig, lifecycle: PantaLifecycle): void { lifecycles.set(config, lifecycle); runtimes.set(config, lifecycle.trading); }
