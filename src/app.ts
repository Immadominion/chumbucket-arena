/**
 * Composition root. Assembles the system from config, choosing real vs in-memory
 * adapters at the edges while the core stays identical. With no env set it boots
 * fully self-contained (in-memory log, scripted Gaffer, play-money custody) so it
 * runs anywhere; set keys to light up Walrus, Claude, and real WAL one by one.
 */

import { loadConfig, type AppConfig } from "./config.ts";
import { InMemoryEventStore } from "./core/eventstore/InMemoryEventStore.ts";
import { SqliteEventStore } from "./core/eventstore/SqliteEventStore.ts";
import type { EventStore } from "./core/eventstore/EventStore.ts";
import { InMemoryMemoryStore } from "./core/memory/InMemoryMemoryStore.ts";
import { WalrusMemoryStore } from "./core/memory/WalrusMemoryStore.ts";
import { SdkMemWalClient } from "./core/memory/SdkMemWalClient.ts";
import type { MemoryStore } from "./core/memory/MemoryStore.ts";
import { ReadModel } from "./core/projections/ReadModel.ts";
import { Engine } from "./engine/Engine.ts";
import { MemoryWriter } from "./engine/MemoryWriter.ts";
import { WalrusLedgerMirror } from "./engine/WalrusLedgerMirror.ts";
import { ClaudeGaffer } from "./gaffer/ClaudeGaffer.ts";
import { ScriptedGaffer } from "./gaffer/ScriptedGaffer.ts";
import type { Gaffer } from "./gaffer/Gaffer.ts";
import { PlayLedgerCustody, SolanaCustody, type Custody } from "./ports/Custody.ts";
import { PrivyCustody } from "./ports/PrivyCustody.ts";
import { PrivyDepositGateway, type DepositGateway } from "./ports/PrivyDepositGateway.ts";
import type { Auth } from "./auth/Auth.ts";
import { DevAuth } from "./auth/DevAuth.ts";
import { PrivyAuth } from "./auth/PrivyAuth.ts";
import { MockMatchData, type MatchDataProvider } from "./ports/MatchData.ts";
import { ApiFootballProvider } from "./ports/ApiFootballProvider.ts";
import { FootballDataProvider } from "./ports/FootballDataProvider.ts";
import { TxlineMatchData } from "./ports/TxlineMatchData.ts";
import { TxlineSettlementVerifier, type FixtureIdMap } from "./ports/TxlineSettlementVerifier.ts";
import { StubSettlementVerifier, type SettlementVerifier } from "./ports/SettlementVerifier.ts";
import { NoopSocialStore, SupabaseSocialStore, type SocialStore } from "./social/SocialStore.ts";
import txoracleIdl from "../vendor/txline/idl/txoracle.json" with { type: "json" };
import { seedFixtures } from "./data/fixtures.ts";

export interface App {
  config: AppConfig;
  store: EventStore;
  readModel: ReadModel;
  engine: Engine;
  gaffer: Gaffer;
  auth: Auth;
  memory: MemoryStore;
  memoryWriter: MemoryWriter;
  ledgerMirror: WalrusLedgerMirror;
  matchData: MatchDataProvider;
  social: SocialStore;
  /** Description of which adapters are live — handy for /health and the demo. */
  wiring: Record<string, string>;
}

export interface CreateAppOptions {
  config?: AppConfig;
  store?: EventStore;
  memory?: MemoryStore;
  gaffer?: Gaffer;
  auth?: Auth;
  custody?: Custody;
  depositGateway?: DepositGateway;
  matchData?: MatchDataProvider;
  settlementVerifier?: SettlementVerifier;
  social?: SocialStore;
  /** Seed the Mock provider's fixtures (ignored if matchData is supplied). */
  now?: number;
}

/** wss:// companion of an https:// Solana RPC URL — the standard same-host convention. */
function deriveWsUrl(rpcUrl: string): string {
  return rpcUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

export async function createApp(opts: CreateAppOptions = {}): Promise<App> {
  const config = opts.config ?? loadConfig();
  const wiring: Record<string, string> = {};

  const store =
    opts.store ?? (config.eventLogPath ? new SqliteEventStore(config.eventLogPath) : new InMemoryEventStore());
  wiring.eventStore = opts.store ? "custom" : config.eventLogPath ? "sqlite" : "in-memory";

  const readModel = new ReadModel();
  await readModel.hydrate(store); // replay + subscribe before anything writes

  const memory: MemoryStore =
    opts.memory ??
    (config.memwal
      ? new WalrusMemoryStore(new SdkMemWalClient(config.memwal))
      : new InMemoryMemoryStore());
  wiring.memory = opts.memory ? "custom" : config.memwal ? "walrus" : "in-memory";

  const gaffer: Gaffer =
    opts.gaffer ??
    (config.anthropicApiKey
      ? new ClaudeGaffer(config.anthropicApiKey, memory, readModel, {
          model: config.models.default,
          verdictModel: config.models.verdict,
        })
      : new ScriptedGaffer(memory, readModel));
  wiring.gaffer = opts.gaffer ? "custom" : config.anthropicApiKey ? "claude" : "scripted";

  const solanaReady = !!(config.solana.sessionsAddress && config.solana.sessionsKey && config.solana.usdcMint);
  // Privy MPC custody (no env-var key): opt-in, needs Privy creds + a USDC mint.
  const privyCustodyReady = !!(config.solana.privyCustody && config.privy?.appSecret && config.solana.usdcMint);
  if (!opts.custody && config.solana.sessionsKey && !config.solana.usdcMint) {
    console.warn("[custody] SESSIONS_WALLET_* set but USDC_MINT missing → staying on play-money");
  }
  let custody: Custody;
  if (opts.custody) {
    custody = opts.custody;
    wiring.custody = "custom";
  } else if (privyCustodyReady) {
    // The Sessions wallet is a Privy server wallet; its key never touches our env.
    custody = await PrivyCustody.create({
      appId: config.privy!.appId,
      appSecret: config.privy!.appSecret!,
      rpcUrl: config.solana.rpcUrl,
      rpcSubscriptionsUrl: deriveWsUrl(config.solana.rpcUrl),
      usdcMint: config.solana.usdcMint!,
      ...(config.solana.sessionsExternalId ? { sessionsExternalId: config.solana.sessionsExternalId } : {}),
    });
    wiring.custody = "privy";
  } else if (solanaReady) {
    custody = await SolanaCustody.create({
      rpcUrl: config.solana.rpcUrl,
      rpcSubscriptionsUrl: deriveWsUrl(config.solana.rpcUrl),
      sessionsAddress: config.solana.sessionsAddress!,
      sessionsKey: config.solana.sessionsKey!,
      usdcMint: config.solana.usdcMint!,
    });
    wiring.custody = "solana";
  } else {
    custody = new PlayLedgerCustody();
    wiring.custody = "play-money";
  }

  // Custodial deposits: sweep USDC from each player's Privy wallet into the float.
  // Available exactly when Privy custody is (same creds + USDC mint).
  let depositGateway: DepositGateway | undefined = opts.depositGateway;
  if (!depositGateway && privyCustodyReady) {
    depositGateway = await PrivyDepositGateway.create({
      appId: config.privy!.appId,
      appSecret: config.privy!.appSecret!,
      rpcUrl: config.solana.rpcUrl,
      rpcSubscriptionsUrl: deriveWsUrl(config.solana.rpcUrl),
      usdcMint: config.solana.usdcMint!,
      ...(config.solana.sessionsExternalId ? { sessionsExternalId: config.solana.sessionsExternalId } : {}),
    });
  }
  wiring.deposits = opts.depositGateway ? "custom" : depositGateway ? "privy-sweep" : "none";

  const matchData =
    opts.matchData ??
    (config.txline
      ? new TxlineMatchData({ apiBaseUrl: config.txline.apiBaseUrl, jwt: config.txline.jwt, apiToken: config.txline.apiToken, cacheTtlMs: 30_000 })
      : config.footballData
        ? new FootballDataProvider(config.footballData)
        : config.football
          ? new ApiFootballProvider(config.football)
          : new MockMatchData(seedFixtures(opts.now ?? Date.now())));
  wiring.matchData = opts.matchData
    ? "custom"
    : config.txline
      ? "txline"
      : config.footballData
        ? "football-data"
        : config.football
          ? "api-football"
          : "mock";

  // The seam SettlementVerifier reads: resolve a MatchId back to the TxLINE
  // fixture id + home/away flag that TxlineMatchData attached to the fixture.
  const fixtureMap: FixtureIdMap = {
    async resolve(matchId) {
      const txline = readModel.pots.getMatch(matchId)?.fixture.txline;
      return txline && { txlineFixtureId: txline.fixtureId, participant1IsHome: txline.participant1IsHome };
    },
  };
  const settlementVerifier: SettlementVerifier =
    opts.settlementVerifier ??
    (config.txline
      ? new TxlineSettlementVerifier({
          rpcUrl: config.txline.rpcUrl,
          programId: config.txline.programId,
          apiBaseUrl: config.txline.apiBaseUrl,
          jwt: config.txline.jwt,
          apiToken: config.txline.apiToken,
          fixtureMap,
          idl: txoracleIdl as unknown as ConstructorParameters<typeof TxlineSettlementVerifier>[0]["idl"],
        })
      : new StubSettlementVerifier(true));
  wiring.settlementVerifier = opts.settlementVerifier ? "custom" : config.txline ? "txline" : "stub";

  const social: SocialStore =
    opts.social ??
    (config.social
      ? new SupabaseSocialStore(config.social)
      : new NoopSocialStore());
  wiring.social = opts.social ? "custom" : config.social ? "supabase" : "none";

  const auth: Auth =
    opts.auth ??
    (config.privy?.appSecret
      ? new PrivyAuth(config.privy.appId, config.privy.appSecret, config.privy.verificationKey)
      : new DevAuth());
  wiring.auth = opts.auth ? "custom" : config.privy?.appSecret ? "privy" : "dev";

  const realCustody = wiring.custody === "solana" || wiring.custody === "privy";

  // Fail closed: real USDC custody with unverified DevAuth would let anyone drain
  // any player's funds via a forged `x-wallet` header. Never boot that combination.
  if (realCustody && wiring.auth === "dev") {
    throw new Error(
      "Refusing to boot: real USDC custody requires real auth. Set PRIVY_APP_SECRET, or unset USDC_MINT to run play-money.",
    );
  }

  // Fail closed: real USDC custody with the always-true stub verifier would settle
  // matches (and pay out real money) with zero on-chain corroboration. Never boot
  // that combination — a real settlement verifier (config.txline) is required.
  if (realCustody && wiring.settlementVerifier === "stub") {
    throw new Error(
      "Refusing to boot: real USDC custody requires a real settlement verifier. Set TXLINE_* env, or unset USDC_MINT to run play-money.",
    );
  }
  // Real custody without the deposit sweep gateway means players could never fund —
  // surface it loudly rather than silently accepting deposits nobody can make.
  if (realCustody && wiring.deposits === "none") {
    console.warn("[boot] real custody is on but no deposit gateway is wired — players cannot deposit.");
  }
  console.log("[boot] wiring:", JSON.stringify(wiring));

  // Memory writer turns events into Walrus memories. Subscribe AFTER the read
  // model so fixture/dossier context is current when a memory is written.
  const memoryWriter = new MemoryWriter(memory, readModel);
  memoryWriter.attach((listener) => store.subscribe(listener));

  // Mirror the money-determining events to Walrus so balances are recoverable,
  // not just a local-sqlite promise (the "money on Walrus" half of the story).
  const ledgerMirror = new WalrusLedgerMirror(memory, `${config.game.namespacePrefix}:ledger`);
  ledgerMirror.attach((listener) => store.subscribe(listener));

  const engine = new Engine({
    store,
    readModel,
    custody,
    gaffer,
    matchData,
    settlementVerifier,
    config: config.game,
    ...(depositGateway ? { depositGateway } : {}),
  });

  return { config, store, readModel, engine, gaffer, auth, memory, memoryWriter, ledgerMirror, matchData, social, wiring };
}
