/** Native Panta composition. Production never falls back to memory or DevAuth. */
import { PublicKey } from "@solana/web3.js";
import type { AppConfig } from "../config.ts";
import { PantaVenue } from "./PantaVenue.ts";
import { PantaExecution } from "./PantaExecution.ts";
import { PantaChain } from "./PantaChain.ts";
import { pantaPost } from "./PantaHttp.ts";
import { SupabasePantaTradingStore } from "./PantaTradingStore.ts";
import { PantaTradingService } from "./PantaTradingService.ts";
import { PgrestError } from "./pgrest.ts";
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

const runtimes = new WeakMap<AppConfig, PantaTradingService>();
export function pantaTradingFor(config: AppConfig, forRead = false): PantaTradingService {
  const ready = pantaTradingReadiness(config, forRead);
  if (!ready.enabled) throw new VenueError("FUNDED_POSITIONS_DISABLED", ready.reason!, { venue: "panta" });
  const held = runtimes.get(config); if (held) return held;
  const panta = config.predictions!.panta!;
  const chain = new PantaChain(config.solana.rpcUrl);
  // This dedicated durable transport does not propagate native exception causes
  // or database error details containing a signed approval to logs/responses.
  const safeFetch: typeof fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (res.ok) return res;
      return new Response(JSON.stringify({ message: "Panta ledger refused the operation" }), { status: res.status });
    } catch { throw new PgrestError("Panta durable ledger request did not complete"); }
  }, { preconnect: fetch.preconnect });
  const execution = new PantaExecution({ request: pantaPost(panta.apiKey, panta.timeoutMs), programId: panta.programId!, providerUserId: panta.partnerUserId!, verifyTransaction: input => chain.verifyTransaction(input) });
  const service = new PantaTradingService({
    store: new SupabasePantaTradingStore(config.social!, safeFetch), execution, chain,
    venue: new PantaVenue({ apiKey: panta.apiKey, timeoutMs: panta.timeoutMs }),
    maxAmountBaseUnits: config.predictions!.maxAmountBaseUnits!,
  });
  runtimes.set(config, service); return service;
}
/** Test seam, scoped to the exact AppConfig object. Never selected by env. */
export function setPantaTradingRuntime(config: AppConfig, service: PantaTradingService): void { runtimes.set(config, service); }
