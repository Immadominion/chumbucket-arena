/**
 * Composition root. Assembles the system from config, choosing real vs in-memory
 * adapters at the edges while the core stays identical. With no env set it boots
 * fully self-contained (in-memory log, scripted Gaffer, play-money custody) so it
 * runs anywhere; set keys to light up Walrus, Claude, and real WAL one by one.
 */
import { type AppConfig } from "./config";
import type { EventStore } from "./core/eventstore/EventStore";
import type { MemoryStore } from "./core/memory/MemoryStore";
import { ReadModel } from "./core/projections/ReadModel";
import { Engine } from "./engine/Engine";
import { MemoryWriter } from "./engine/MemoryWriter";
import { WalrusLedgerMirror } from "./engine/WalrusLedgerMirror";
import type { Gaffer } from "./gaffer/Gaffer";
import { type Custody } from "./ports/Custody";
import { type DepositGateway } from "./ports/PrivyDepositGateway";
import type { Auth } from "./auth/Auth";
import { type MatchDataProvider } from "./ports/MatchData";
import { type SettlementVerifier } from "./ports/SettlementVerifier";
import { type SocialStore } from "./social/SocialStore";
import { ArenaReconciler } from "./indexer/ArenaReconciler";
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
    /** Pull-based chain->read-model reconciler (present when social + reconciler configured). */
    reconciler?: ArenaReconciler;
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
export declare function createApp(opts?: CreateAppOptions): Promise<App>;
