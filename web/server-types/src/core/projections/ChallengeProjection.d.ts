/**
 * The Challenges — private 1-v-1 escrows, folded from the log. Each challenge is
 * its own aggregate on a `gaffer:challenge:<id>` stream: who created it, which
 * sides the two players hold, its stake, and how it resolved. Deliberately kept
 * OUT of the communal Pots — a challenge is a 2-party wager, isolated from the
 * parimutuel pool and its thin-pool guard.
 *
 * Also the challenge settlement saga's worklist: `matchedFor(matchId)` lists the
 * MATCHED challenges a resolved match still owes a settlement.
 */
import type { StoredEvent } from "../../domain/events";
import type { ChallengeId, Frost, MatchId, Wallet } from "../../domain/ids";
import type { Projection } from "./Projection";
export type ChallengeStatus = "OPEN" | "MATCHED" | "SETTLED" | "VOID" | "CANCELLED";
export interface ChallengeView {
    challengeId: ChallengeId;
    matchId: MatchId;
    creator: Wallet;
    opponent: Wallet | null;
    creatorSide: string;
    opponentSide: string;
    stake: Frost;
    status: ChallengeStatus;
    winner: Wallet | null;
    winningBucket: string | null;
    createdAt: number;
    settledAt: number | null;
}
export declare class ChallengeProjection implements Projection {
    readonly name = "challenges";
    private readonly byId;
    apply(event: StoredEvent): void;
    get(challengeId: ChallengeId): ChallengeView | undefined;
    /** Every challenge this wallet is a party to (creator or opponent), newest first. */
    forWallet(wallet: Wallet): ChallengeView[];
    /** MATCHED challenges awaiting a result on this match — the settlement worklist. */
    matchedFor(matchId: MatchId): ChallengeView[];
}
