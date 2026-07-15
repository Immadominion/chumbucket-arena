/**
 * A deterministic Gaffer that needs no API key. It still *uses the memory* — it
 * recalls real records from Walrus and weaves them into its lines — so the whole
 * loop (and the day-1-vs-day-5 contrast) is demonstrable offline, in tests, and
 * as a fallback if the model is unavailable. ClaudeGaffer is the real voice.
 */

import { playerStream, type Wallet } from "../domain/ids.ts";
import type { MemoryStore } from "../core/memory/MemoryStore.ts";
import type { ReadModel } from "../core/projections/ReadModel.ts";
import type {
  ChatContext,
  DistilledTrait,
  Gaffer,
  PreBetContext,
  ResultContext,
  Verdict,
  VerdictContext,
} from "./Gaffer.ts";

const pct = (p: number) => Math.round(p * 100);

export class ScriptedGaffer implements Gaffer {
  constructor(
    private readonly memory: MemoryStore,
    private readonly readModel: ReadModel,
  ) {}

  async preBetRead(ctx: PreBetContext): Promise<string> {
    const d = this.readModel.getDossier(ctx.wallet);
    const ns = playerStream(ctx.wallet);
    const played = d ? d.record.won + d.record.lost : 0;
    const where = `${ctx.fixture.home} v ${ctx.fixture.away}`;

    if (!d || played === 0) {
      return `Don't know you from Adam yet. ${ctx.bucketLabel} on ${where} at ${pct(ctx.impliedProb)}%? Give me three calls and we'll see if you've got an eye.`;
    }

    const lines: string[] = [];
    if (d.form.cold) {
      lines.push(
        `You're on a cold run (${d.form.recent.join(" ")}) and about to drop ${ctx.stakeWal} WAL. That's exactly when you tilt. Half it or walk.`,
      );
    }
    const memories = await this.memory.recall(ns, `${where} ${ctx.bucketLabel}`, 4);
    const relevant = memories.find((m) => m.kind === "result" || m.kind === "call");
    if (relevant) lines.push(`Remember this? "${relevant.text}"`);
    if (ctx.impliedProb > 0.6) {
      lines.push(`The whole league's on ${ctx.bucketLabel} — ${pct(ctx.impliedProb)}%. Tiny payout. You sure you want the crowd's bet?`);
    } else if (ctx.impliedProb < 0.25) {
      lines.push(`Contrarian. ${pct(ctx.impliedProb)}% says you're mad. If it lands, your rating jumps.`);
    }
    return lines.length ? lines.join(" ") : `${ctx.bucketLabel} at ${pct(ctx.impliedProb)}%. Fine. Show me.`;
  }

  async reactToResult(ctx: ResultContext): Promise<string> {
    const where = `${ctx.fixture.home} v ${ctx.fixture.away}`;
    if (ctx.won) return `${where} — called it. ${ctx.payoutWal} WAL back. That's the version of you I want.`;
    return `${where} — wrong. ${ctx.stakeWal} WAL gone. We've seen this one before.`;
  }

  async composeVerdict(ctx: VerdictContext): Promise<Verdict> {
    const d = this.readModel.getDossier(ctx.wallet);
    const ns = playerStream(ctx.wallet);
    if (!d) return { text: "Sign for me first, then I'll have something to say.", quotes: [] };

    const timeline = await this.memory.timeline(ns, 10);
    const quotes = d.hotTakes.slice(0, 2).map((t) => t.text);
    const head = `${d.tier}. ${d.record.won}W-${d.record.lost}L, rating ${d.gr}.`;
    const formNote = d.form.hot
      ? "On a heater — and starting to believe it."
      : d.form.cold
        ? "Cold. Benched in my eyes until you string two together."
        : "Streaky.";
    const trait = d.traits[0];
    const traitNote = trait ? ` I've got you down as: ${trait.label.toLowerCase()}.` : "";
    const landmark = d.landmarks[0]
      ? ` Best of you: ${d.landmarks[0].text}`
      : timeline[0]
        ? ` Last thing of note: ${timeline[0].text}`
        : "";
    const quoteNote = quotes.length ? ` And you still reckon "${quotes[0]}". We'll see.` : "";

    return { text: `${head} ${formNote}${traitNote}${landmark}${quoteNote}`.trim(), quotes };
  }

  async chat(ctx: ChatContext): Promise<string> {
    const ns = playerStream(ctx.wallet);
    const d = this.readModel.getDossier(ctx.wallet);
    if (!d) return "You've not signed for me. Do that, make some calls, then we'll talk.";
    const hits = await this.memory.recall(ns, ctx.message, 3);
    if (hits[0]) return `You say that. But I remember: "${hits[0].text}" So forgive me if I'm not sold.`;
    return `Noted. You're ${d.tier}, ${d.record.won}W-${d.record.lost}L. Talk's cheap — make the call.`;
  }

  async distillTraits(wallet: Wallet): Promise<DistilledTrait[]> {
    const d = this.readModel.getDossier(wallet);
    if (!d) return [];
    const out: DistilledTrait[] = [];
    const played = d.record.won + d.record.lost;
    if (played >= 3 && d.record.lost > d.record.won) {
      out.push({
        key: "shaky-finisher",
        label: "Loses more than he wins — needs to pick his spots",
        confidence: Math.min(0.5 + (d.record.lost - d.record.won) * 0.1, 0.9),
        evidence: `${d.record.won}W-${d.record.lost}L on the record so far.`,
      });
    }
    if (d.form.cold) {
      out.push({
        key: "tilts-on-cold-runs",
        label: "Chases it when cold instead of stepping back",
        confidence: 0.6,
        evidence: `Current form ${d.form.recent.join(" ")}.`,
      });
    }
    if (d.form.hot) {
      out.push({
        key: "rides-momentum",
        label: "Dangerous in form — backs himself on a run",
        confidence: 0.6,
        evidence: `Current form ${d.form.recent.join(" ")}.`,
      });
    }
    return out;
  }
}
