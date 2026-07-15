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

import Anthropic from "@anthropic-ai/sdk";
import { playerStream, type Wallet } from "../domain/ids.ts";
import type { MemoryStore } from "../core/memory/MemoryStore.ts";
import type { ReadModel } from "../core/projections/ReadModel.ts";
import {
  GAFFER_PERSONA,
  OUTPUT_SPEC,
  renderMemories,
  sanitizeGafferText,
  summariseDossier,
  type GafferUseCase,
} from "./prompts.ts";
import { ScriptedGaffer } from "./ScriptedGaffer.ts";
import type {
  ChatContext,
  DistilledTrait,
  Gaffer,
  PreBetContext,
  ResultContext,
  Verdict,
  VerdictContext,
} from "./Gaffer.ts";

const DEFAULT_MODEL = "claude-haiku-4-5";

export interface ClaudeGafferOptions {
  model?: string; // default voice
  verdictModel?: string; // optionally upgrade just the shareable card
}

const textOf = (res: Anthropic.Messages.Message): string =>
  res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

export class ClaudeGaffer implements Gaffer {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly verdictModel: string;
  private readonly fallback: ScriptedGaffer;

  constructor(
    apiKey: string,
    private readonly memory: MemoryStore,
    private readonly readModel: ReadModel,
    opts: ClaudeGafferOptions = {},
  ) {
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.verdictModel = opts.verdictModel ?? this.model;
    this.fallback = new ScriptedGaffer(memory, readModel);
  }

  /** One memory-aware generation, fully gated. Throws on empty/invalid output. */
  private async generate(
    useCase: GafferUseCase,
    wallet: Wallet,
    recallQuery: string,
    situation: string,
    model = this.model,
  ): Promise<string> {
    const spec = OUTPUT_SPEC[useCase];
    const dossier = this.readModel.getDossier(wallet);
    const memories = await this.memory.recall(playerStream(wallet), recallQuery, 8);
    const user = [
      summariseDossier(dossier),
      "",
      renderMemories(memories),
      "",
      `SITUATION: ${situation}`,
    ].join("\n");

    const res = await this.client.messages.create({
      model,
      max_tokens: spec.maxTokens,
      system: GAFFER_PERSONA,
      messages: [{ role: "user", content: user }],
    });
    const text = sanitizeGafferText(textOf(res), spec.maxChars);
    if (!text) throw new Error(`empty ${useCase} output`);
    return text;
  }

  /** Run the model; on any failure, use the deterministic fallback for this call. */
  private async guard<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      return await primary();
    } catch (err) {
      console.error("[gaffer] fell back to scripted:", (err as Error).message);
      return fallback();
    }
  }

  preBetRead(ctx: PreBetContext): Promise<string> {
    return this.guard(
      () =>
        this.generate(
          "preBet",
          ctx.wallet,
          `${ctx.fixture.home} ${ctx.fixture.away} ${ctx.bucketLabel}`,
          `The player is about to stake ${ctx.stakeWal} WAL on "${ctx.bucketLabel}" (${ctx.marketLabel}) in ${ctx.fixture.home} v ${ctx.fixture.away}. The crowd has that outcome at ${Math.round(
            ctx.impliedProb * 100,
          )}%. Give your pre-bet read — coach them using their own patterns. One or two sentences.`,
        ),
      () => this.fallback.preBetRead(ctx),
    );
  }

  reactToResult(ctx: ResultContext): Promise<string> {
    return this.guard(
      () =>
        this.generate(
          "result",
          ctx.wallet,
          `${ctx.fixture.home} ${ctx.fixture.away}`,
          `Their call on ${ctx.fixture.home} v ${ctx.fixture.away} just ${
            ctx.won ? `WON — ${ctx.payoutWal} WAL back` : `LOST — ${ctx.stakeWal} WAL gone`
          }. React in one sentence, with a receipt from memory if you have one.`,
        ),
      () => this.fallback.reactToResult(ctx),
    );
  }

  composeVerdict(ctx: VerdictContext): Promise<Verdict> {
    return this.guard(
      async () => {
        const text = await this.generate(
          "verdict",
          ctx.wallet,
          "verdict summary record traits hot takes landmark",
          `Deliver your VERDICT on this player (${ctx.trigger}). This is a shareable card — make it quotable, with at least one specific receipt from memory. 2-4 sentences.`,
          this.verdictModel,
        );
        const quotes = (this.readModel.getDossier(ctx.wallet)?.hotTakes ?? [])
          .slice(0, 3)
          .map((t) => t.text);
        return { text, quotes };
      },
      () => this.fallback.composeVerdict(ctx),
    );
  }

  chat(ctx: ChatContext): Promise<string> {
    return this.guard(
      () =>
        this.generate(
          "chat",
          ctx.wallet,
          ctx.message,
          `The player says to you: "${ctx.message}". Reply in character, referencing their memory where it bites.`,
        ),
      () => this.fallback.chat(ctx),
    );
  }

  async distillTraits(wallet: Wallet): Promise<DistilledTrait[]> {
    try {
      const memories = await this.memory.recall(
        playerStream(wallet),
        "betting patterns tilt favourites underdogs stake",
        20,
      );
      if (memories.length < 3) return this.fallback.distillTraits(wallet);
      const user = [
        renderMemories(memories),
        "",
        `From this memory, distil up to 4 behavioural betting patterns about this player. Return ONLY a JSON array of objects with keys: key (kebab-case slug), label (short sentence), confidence (0..1), evidence (cite the memory). No prose.`,
      ].join("\n");
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        system: GAFFER_PERSONA,
        messages: [{ role: "user", content: user }],
      });
      const traits = parseTraits(textOf(res));
      return traits.length ? traits : this.fallback.distillTraits(wallet);
    } catch (err) {
      console.error("[gaffer] trait distillation fell back:", (err as Error).message);
      return this.fallback.distillTraits(wallet);
    }
  }
}

function parseTraits(raw: string): DistilledTrait[] {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
      .map((t) => ({
        key: String(t.key ?? "").slice(0, 48),
        label: String(t.label ?? "").slice(0, 160),
        confidence: Math.max(0, Math.min(1, Number(t.confidence) || 0.5)),
        evidence: String(t.evidence ?? "").slice(0, 240),
      }))
      .filter((t) => t.key && t.label);
  } catch {
    return [];
  }
}
