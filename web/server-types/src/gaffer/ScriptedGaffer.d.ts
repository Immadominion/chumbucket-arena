/**
 * A deterministic Gaffer that needs no API key. It still *uses the memory* — it
 * recalls real records from Walrus and weaves them into its lines — so the whole
 * loop (and the day-1-vs-day-5 contrast) is demonstrable offline, in tests, and
 * as a fallback if the model is unavailable. ClaudeGaffer is the real voice.
 */
import { type Wallet } from "../domain/ids";
import type { MemoryStore } from "../core/memory/MemoryStore";
import type { ReadModel } from "../core/projections/ReadModel";
import type { ChatContext, DistilledTrait, Gaffer, PreBetContext, ResultContext, Verdict, VerdictContext } from "./Gaffer";
export declare class ScriptedGaffer implements Gaffer {
    private readonly memory;
    private readonly readModel;
    constructor(memory: MemoryStore, readModel: ReadModel);
    preBetRead(ctx: PreBetContext): Promise<string>;
    reactToResult(ctx: ResultContext): Promise<string>;
    composeVerdict(ctx: VerdictContext): Promise<Verdict>;
    chat(ctx: ChatContext): Promise<string>;
    distillTraits(wallet: Wallet): Promise<DistilledTrait[]>;
}
