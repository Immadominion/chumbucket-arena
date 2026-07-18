/**
 * The settled-calls ledger — a per-player history of resolved calls, folded from
 * the log. Joins three event sources: CallMade (which bucket you backed),
 * CallSettled / CallVoided (the outcome + P&L + rating change), and the match's
 * MatchResolved (the actual score). This is what the Results + Verdict screens read.
 */
import type { StoredEvent } from "../../domain/events";
import type { CallId, Frost, MarketId, MatchId, Wallet } from "../../domain/ids";
import type { Projection } from "./Projection";
export interface SettledCallView {
    callId: CallId;
    matchId: MatchId;
    marketId: MarketId;
    bucket: string;
    result: "WON" | "LOST" | "VOID";
    stake: Frost;
    payout: Frost;
    pnlDelta: Frost;
    grDelta: number;
    difficulty: number;
    score: {
        home: number;
        away: number;
    } | undefined;
    at: number;
}
export declare class SettledCallsProjection implements Projection {
    readonly name = "settledCalls";
    private readonly byWallet;
    private readonly open;
    private readonly scores;
    apply(event: StoredEvent): void;
    private record;
    get(wallet: Wallet, limit?: number): SettledCallView[];
}
