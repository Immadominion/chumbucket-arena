/**
 * The query side of CQRS. Owns every projection, hydrates them from the event
 * log on boot, then tails the store so reads are always current. Exposes the
 * derived views the API serves: dossiers, pots, leaderboards, the Manager's Pot.
 */
import type { StoredEvent } from "../../domain/events";
import { type ChallengeId, type Frost, type Wallet } from "../../domain/ids";
import type { Tier } from "../../domain/model";
import type { FormState } from "../../game/form";
import type { EventStore } from "../eventstore/EventStore";
import { ChallengeProjection } from "./ChallengeProjection";
import { ChatProjection } from "./ChatProjection";
import { DossierProjection, type DossierView } from "./DossierProjection";
import { PotProjection } from "./PotProjection";
import { SettledCallsProjection } from "./SettledCallsProjection";
export interface LeaderboardEntry {
    rank: number;
    wallet: Wallet;
    handle: string | undefined;
    gr: number;
    tier: Tier;
    pnl: Frost;
    record: {
        won: number;
        lost: number;
        voided: number;
    };
    form: FormState;
}
export declare class ReadModel {
    readonly dossier: DossierProjection;
    readonly pots: PotProjection;
    readonly settled: SettledCallsProjection;
    readonly chat: ChatProjection;
    readonly challenges: ChallengeProjection;
    private readonly projections;
    private managersPot;
    private houseRevenue;
    apply(event: StoredEvent): void;
    /** Replay the whole log, then subscribe to the live tail. */
    hydrate(store: EventStore): Promise<void>;
    managersPotTotal(): Frost;
    houseRevenueTotal(): Frost;
    /** The Squad Ladder — by GR (skill). This is the canonical ranking. */
    leaderboardByGr(limit?: number): LeaderboardEntry[];
    /** The Winnings board — by realised P&L (money). Never drives rank. */
    leaderboardByPnl(limit?: number): LeaderboardEntry[];
    getDossier(wallet: Wallet): DossierView | undefined;
    getChallenge(challengeId: ChallengeId): import("./ChallengeProjection").ChallengeView | undefined;
    myChallenges(wallet: Wallet): import("./ChallengeProjection").ChallengeView[];
    settledCalls(wallet: Wallet, limit?: number): import("./SettledCallsProjection").SettledCallView[];
    chatHistory(wallet: Wallet, limit?: number): import("./ChatProjection").ChatEntry[];
}
