/**
 * The Gaffer port — the AI manager's voice. Every method is memory-aware: given
 * a wallet, the implementation recalls that player's history from Walrus and
 * speaks from it. The actor/engine decide *when* he speaks; he decides *what*.
 *
 * Two implementations: ClaudeGaffer (real, Opus 4.8) and ScriptedGaffer (a
 * deterministic stand-in so the whole loop runs and tests pass without an API
 * key). Both honour this contract.
 */
import type { Wallet } from "../domain/ids";
import type { Fixture, VerdictTrigger } from "../domain/model";
export interface PreBetContext {
    wallet: Wallet;
    fixture: Fixture;
    marketLabel: string;
    bucketLabel: string;
    stakeWal: string;
    impliedProb: number;
}
export interface ResultContext {
    wallet: Wallet;
    fixture: Fixture;
    won: boolean;
    payoutWal: string;
    stakeWal: string;
}
export interface VerdictContext {
    wallet: Wallet;
    trigger: VerdictTrigger;
}
export interface ChatContext {
    wallet: Wallet;
    message: string;
}
export interface DistilledTrait {
    key: string;
    label: string;
    confidence: number;
    evidence: string;
}
export interface Verdict {
    text: string;
    quotes: string[];
}
export interface Gaffer {
    /** The coaching moment, before a stake is locked. Pulls the player's patterns. */
    preBetRead(ctx: PreBetContext): Promise<string>;
    /** A short, memory-aware reaction the instant a result lands. */
    reactToResult(ctx: ResultContext): Promise<string>;
    /** The shareable roast/summary, with receipts. */
    composeVerdict(ctx: VerdictContext): Promise<Verdict>;
    /** Free conversation — he references history unprompted. */
    chat(ctx: ChatContext): Promise<string>;
    /** Re-read the memory and distil behavioural traits to persist. */
    distillTraits(wallet: Wallet): Promise<DistilledTrait[]>;
}
