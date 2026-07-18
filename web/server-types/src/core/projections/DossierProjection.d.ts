/**
 * The Dossier — the Gaffer's file on a player, folded from their event stream.
 * This is the memory made legible: balance & P&L (money), GR & tier (skill),
 * record & form, open calls, distilled traits, hot takes, landmark calls.
 *
 * GR is the running sum of grDelta from BASE_GR; tier is *derived* from GR (you
 * can't buy rank). TierChanged events exist only to narrate the moment.
 */
import type { StoredEvent } from "../../domain/events";
import type { CallId, ChallengeId, Frost, MarketId, MatchId, Wallet } from "../../domain/ids";
import type { Tier, Trait } from "../../domain/model";
import { type FormState } from "../../game/form";
import type { Projection } from "./Projection";
export interface OpenCallView {
    callId: CallId;
    matchId: MatchId;
    marketId: MarketId;
    bucket: string;
    stake: Frost;
    impliedProbAtCall: number;
    bold: boolean;
    at: number;
}
/** A stake locked into a live 1-v-1 challenge, awaiting the match result. */
export interface OpenChallengeStakeView {
    challengeId: ChallengeId;
    matchId: MatchId;
    side: string;
    stake: Frost;
    at: number;
}
export interface DossierView {
    wallet: Wallet;
    handle: string | undefined;
    signedAt: number;
    balance: Frost;
    locked: Frost;
    bonus: Frost;
    claimedGrant: boolean;
    gr: number;
    tier: Tier;
    nextTier: {
        tier: Tier;
        min: number;
    } | null;
    pnl: Frost;
    record: {
        won: number;
        lost: number;
        voided: number;
    };
    form: FormState;
    openCalls: OpenCallView[];
    openChallengeStakes: OpenChallengeStakeView[];
    traits: Trait[];
    hotTakes: {
        takeId: string;
        text: string;
        at: number;
    }[];
    landmarks: {
        callId: CallId;
        matchId: MatchId;
        text: string;
        at: number;
    }[];
    lastVerdict: {
        text: string;
        at: number;
        trigger: string;
    } | undefined;
}
export declare class DossierProjection implements Projection {
    readonly name = "dossier";
    private readonly byWallet;
    apply(event: StoredEvent): void;
    private walletOf;
    get(wallet: Wallet): DossierView | undefined;
    all(): DossierView[];
}
