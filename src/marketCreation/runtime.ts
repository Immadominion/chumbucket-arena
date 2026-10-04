/**
 * Lazy composition of market creation, memoised per AppConfig object (the
 * same pattern as the calls and Panta trading runtimes). Nothing is built at
 * import time, and production never falls back to the in-memory store.
 */
import type { AppConfig } from "../config.ts";
import { callsRuntimeFor } from "../calls/runtime.ts";
import { PantaChain } from "../prediction/PantaChain.ts";
import { PgrestError } from "../prediction/pgrest.ts";
import { predictionRuntimeFor } from "../prediction/runtime.ts";
import { readsIndicativePrices } from "../prediction/PredictionVenue.ts";
import { sharePriceFromIndicative } from "../prediction/sharePrices.ts";
import { capturesRaw } from "../prediction/PredictionVenue.ts";
import { proposalsReadiness, publishingReadiness, resolveMarketCreationConfig, type MarketCreationConfig } from "./config.ts";
import { MarketCreationError } from "./errors.ts";
import { MarketCreationService, type CatalogIngest, type PersonRef } from "./MarketCreationService.ts";
import { cloudinaryUpload, pantaCreatePost, PantaMarketCreator } from "./PantaMarketCreator.ts";
import { SupabaseMarketProposalStore } from "./store.ts";
import { SupabaseAccountWallets } from "../wallet/accountWallets.ts";
import { authIdentityRuntimeFor } from "../auth/AuthIdentityRuntime.ts";

export interface MarketCreationRuntime {
  config: MarketCreationConfig;
  service: MarketCreationService;
  proposals: { enabled: boolean; reason: string | null };
  publishing: { enabled: boolean; reason: string | null };
}

const runtimes = new WeakMap<AppConfig, MarketCreationRuntime>();

/** Never leak signed bytes or row values through a database error message. */
const safeFetch: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  try {
    const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (res.ok) return res;
    return new Response(JSON.stringify({ message: "Market proposal storage refused the operation" }), { status: res.status });
  } catch { throw new PgrestError("Market proposal storage did not answer"); }
}, { preconnect: fetch.preconnect });

export function marketCreationFor(app: AppConfig): MarketCreationRuntime {
  const held = runtimes.get(app);
  if (held) return held;
  const config = resolveMarketCreationConfig(app);
  const proposals = proposalsReadiness(app, config);
  const publishing = publishingReadiness(app, config);
  if (!proposals.enabled) {
    // A disabled runtime still answers status; every action refuses.
    const runtime: MarketCreationRuntime = { config, proposals, publishing, service: disabledService(config) };
    runtimes.set(app, runtime);
    return runtime;
  }
  const people = {
    get(id: string): PersonRef | undefined {
      const person = callsRuntimeFor(app).store.getPerson(id);
      return person ? { id: person.id, handle: person.handle, displayName: person.displayName } : undefined;
    },
    // Same read-through the calls viewer uses for a profile created after boot.
    async load(id: string): Promise<void> { await callsRuntimeFor(app).durable?.refreshPerson(id); },
  };
  let publishingDeps: ConstructorParameters<typeof MarketCreationService>[0]["publishing"] = null;
  if (publishing.enabled) {
    const panta = app.predictions!.panta!;
    const creator = new PantaMarketCreator({ request: pantaCreatePost(panta.apiKey, { timeoutMs: panta.timeoutMs }),
      upload: cloudinaryUpload(), programId: panta.programId!, maxFeeBaseUnits: config.maxFeeBaseUnits });
    const catalog: CatalogIngest = { async ingest(venueMarketId) {
      const prediction = predictionRuntimeFor(app);
      await prediction.ready;
      await prediction.marketSync.refreshCalledMarket(venueMarketId);
      // A new market has no share price yet in our mirror; read it once so it
      // is callable now rather than after the next sync pass.
      const market = prediction.store.listMarkets().find(row => row.market.venueMarketId === venueMarketId)?.market;
      if (market && readsIndicativePrices(prediction.venue)) {
        const prices = await prediction.venue.getIndicativePrices(venueMarketId);
        const raw = capturesRaw(prediction.venue) ? prediction.venue.rawPayload(venueMarketId) ?? null : null;
        prediction.store.appendSharePrice(sharePriceFromIndicative(prices), raw);
      }
    } };
    publishingDeps = { creator, chain: new PantaChain(app.solana.rpcUrl), catalog };
  }
  const service = new MarketCreationService({
    store: new SupabaseMarketProposalStore(app.social!, safeFetch),
    reviewerIds: config.reviewerIds, people, publishing: publishingDeps,
    // ~30s covers a normal Solana confirmation; well inside Panta's 40 registers/min.
    followUp: publishingDeps ? { attempts: 6, everyMs: 5_000 } : null,
    // MONEY_CALLS_ENABLED: only the proposer publishes and pays, from their own wallet.
    proposerOnly: app.money?.callsEnabled === true
      ? { wallets: new SupabaseAccountWallets(app.social!, fetch, authIdentityRuntimeFor(app).accountLinks) }
      : null,
  });
  const runtime = { config, proposals, publishing, service };
  runtimes.set(app, runtime);
  return runtime;
}

function disabledService(config: MarketCreationConfig): MarketCreationService {
  const off = async (): Promise<never> => { throw new MarketCreationError("MC_DISABLED", "Market proposals are not switched on yet."); };
  return new MarketCreationService({
    reviewerIds: config.reviewerIds, people: { get: () => undefined },
    store: { insertProposal: off, findByKey: off, proposal: off, byProposer: off, byStatus: off,
      byVenueMarket: async () => null, countPending: off, countSince: off, updateProposal: off,
      insertSession: off, session: off, activeSession: off, updateSession: off },
  });
}

/** Test seam, scoped to the exact AppConfig object. Never selected by env. */
export function setMarketCreationRuntime(app: AppConfig, runtime: MarketCreationRuntime): void { runtimes.set(app, runtime); }
