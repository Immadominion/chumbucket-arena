/**
 * The real Gaffer — Claude. Defaults to the cheapest capable model (Haiku 4.5):
 * the hard reasoning (settlement, rating, parimutuel) is deterministic code, so
 * the model only writes short, persona-driven text grounded in the memory it's
 * handed. That's a small-model job, and Haiku does it well and cheaply.
 *
 * Every generation is gated: capped tokens per use case, sanitised to a hard
 * char ceiling (no markdown/emoji), and validated. If the model errors or
 * returns nothing usable, we fall back to the deterministic ScriptedGaffer for
 * that one call — the user never sees a blank or broken line. The marquee
 * Verdict can be pointed at a stronger model via config without touching this.
 */
import { type Wallet } from "../domain/ids";
import type { MemoryStore } from "../core/memory/MemoryStore";
import type { ReadModel } from "../core/projections/ReadModel";
import type { ChatContext, DistilledTrait, Gaffer, PreBetContext, ResultContext, Verdict, VerdictContext } from "./Gaffer";
export interface ClaudeGafferOptions {
    model?: string;
    verdictModel?: string;
}
export declare class ClaudeGaffer implements Gaffer {
    private readonly memory;
    private readonly readModel;
    private readonly client;
    private readonly model;
    private readonly verdictModel;
    private readonly fallback;
    constructor(apiKey: string, memory: MemoryStore, readModel: ReadModel, opts?: ClaudeGafferOptions);
    /** One memory-aware generation, fully gated. Throws on empty/invalid output. */
    private generate;
    /** Run the model; on any failure, use the deterministic fallback for this call. */
    private guard;
    preBetRead(ctx: PreBetContext): Promise<string>;
    reactToResult(ctx: ResultContext): Promise<string>;
    composeVerdict(ctx: VerdictContext): Promise<Verdict>;
    chat(ctx: ChatContext): Promise<string>;
    distillTraits(wallet: Wallet): Promise<DistilledTrait[]>;
}
