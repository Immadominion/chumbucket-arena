/**
 * Market-creation switches, read here (not in src/config.ts) so the feature is
 * self-contained. Everything defaults OFF:
 *
 *   MARKET_PROPOSALS_ENABLED=true   after 20261002140000_market_proposals.sql is
 *                                   applied; enables propose / review / mine.
 *   MARKET_PUBLISHING_ENABLED=true  emergency switch for the paid Panta create.
 *                                   Also needs the live Panta key, the pinned
 *                                   mainnet program and PANTA_SCHEMA_READY.
 *   MARKET_REVIEWER_USER_IDS        comma-separated public.users ids allowed to
 *                                   approve/reject (and to publish any approved
 *                                   proposal with their own wallet).
 *   MARKET_CREATION_MAX_FEE_BASE_UNITS  refuse a Panta quote above this
 *                                   (default 100000000 = 100 USDC).
 */
import { PublicKey } from "@solana/web3.js";
import type { AppConfig } from "../config.ts";
import { PANTA_MAINNET_PROGRAM_ID } from "../prediction/PantaTradingRuntime.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MarketCreationConfig {
  proposalsEnabled: boolean;
  publishingEnabled: boolean;
  reviewerIds: ReadonlySet<string>;
  maxFeeBaseUnits: string;
}

export interface MarketCreationAppConfig { marketCreation?: Partial<MarketCreationConfig> }

export function resolveMarketCreationConfig(
  appConfig: AppConfig,
  env: Record<string, string | undefined> = process.env,
): MarketCreationConfig {
  const fromApp = (appConfig as AppConfig & MarketCreationAppConfig).marketCreation;
  const reviewers = fromApp?.reviewerIds ?? new Set((env.MARKET_REVIEWER_USER_IDS ?? "").split(",")
    .map(id => id.trim().toLowerCase()).filter(id => UUID.test(id)));
  const maxFee = fromApp?.maxFeeBaseUnits ?? env.MARKET_CREATION_MAX_FEE_BASE_UNITS ?? "100000000";
  return {
    proposalsEnabled: fromApp?.proposalsEnabled ?? env.MARKET_PROPOSALS_ENABLED === "true",
    publishingEnabled: fromApp?.publishingEnabled ?? env.MARKET_PUBLISHING_ENABLED === "true",
    reviewerIds: new Set([...reviewers].map(id => id.toLowerCase())),
    maxFeeBaseUnits: /^[1-9][0-9]{0,15}$/.test(maxFee) ? maxFee : "100000000",
  };
}

export interface Readiness { enabled: boolean; reason: string | null }

/** Proposals need a durable account database and the applied migration. */
export function proposalsReadiness(app: AppConfig, cfg: MarketCreationConfig): Readiness {
  if (!cfg.proposalsEnabled) return { enabled: false, reason: "Market proposals are not switched on yet." };
  if (!app.social) return { enabled: false, reason: "Market proposals need the account database." };
  return { enabled: true, reason: null };
}

/** Publishing spends a real Panta creation fee from the signer's wallet. */
export function publishingReadiness(app: AppConfig, cfg: MarketCreationConfig): Readiness {
  const proposals = proposalsReadiness(app, cfg);
  if (!proposals.enabled) return proposals;
  if (!cfg.publishingEnabled) return { enabled: false, reason: "Publishing to Panta is paused." };
  const panta = app.predictions?.panta;
  if (app.predictions?.venue !== "panta" || !panta?.apiKey?.startsWith("pk_live_")) return { enabled: false, reason: "A live server-held Panta key is required." };
  if (app.predictions.pantaSchemaReady !== true) return { enabled: false, reason: "The Panta catalog schema must be verified first." };
  try {
    if (new PublicKey(panta.programId ?? "").toBase58() !== PANTA_MAINNET_PROGRAM_ID) throw new Error();
  } catch { return { enabled: false, reason: "The verified Panta mainnet program must be pinned." }; }
  try {
    if (new URL(app.solana.rpcUrl).protocol !== "https:") throw new Error();
  } catch { return { enabled: false, reason: "A secure Solana mainnet RPC is required." }; }
  return { enabled: true, reason: null };
}
