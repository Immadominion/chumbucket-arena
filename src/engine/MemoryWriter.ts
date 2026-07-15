/**
 * Turns the event log into the Gaffer's memory. Subscribes to every append and,
 * for the events that matter, writes a natural-language memory into the player's
 * Walrus namespace. This is the layer that makes recall meaningful: the raw log
 * says "CallSettled, grDelta -18"; the memory says "you backed the favourite
 * again and it cost you." The Gaffer reads *these*.
 *
 * Writes go through an internal queue so the command path is never blocked on a
 * network round-trip to Walrus; `drain()` lets tests await a quiet state.
 */

import type { StoredEvent } from "../domain/events.ts";
import { formatWal } from "../domain/ids.ts";
import type { MemoryRecord, MemoryStore } from "../core/memory/MemoryStore.ts";
import type { ReadModel } from "../core/projections/ReadModel.ts";

const playerNamespace = (streamId: string): string | undefined =>
  streamId.startsWith("gaffer:") && !streamId.startsWith("gaffer:match:") ? streamId : undefined;

export class MemoryWriter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly memory: MemoryStore,
    private readonly readModel: ReadModel,
  ) {}

  /** Attach to an event store; returns the unsubscribe handle. */
  attach(subscribe: (listener: (e: StoredEvent) => void) => () => void): () => void {
    return subscribe((e) => this.onEvent(e));
  }

  private onEvent(event: StoredEvent): void {
    const ns = playerNamespace(event.meta.streamId);
    if (!ns) return;
    const record = this.describe(event);
    if (!record) return;
    // enqueue without blocking the append path
    this.queue = this.queue.then(() =>
      this.memory.remember(ns, record).catch((err) => {
        console.error("[memory] write failed:", err);
      }),
    );
  }

  /** Resolve once all queued memory writes have settled. */
  async drain(): Promise<void> {
    await this.queue;
  }

  private describe(event: StoredEvent): Omit<MemoryRecord, "score"> | null {
    const p = event.payload;
    const at = event.meta.at;
    switch (p.type) {
      case "PlayerSigned":
        return { kind: "milestone", at, text: "Signed for the Gaffer. No history yet — a blank slate." };

      case "CallMade": {
        const f = this.readModel.pots.getMatch(p.matchId)?.fixture;
        const where = f ? `${f.home} v ${f.away}` : p.matchId;
        const pct = Math.round(p.impliedProbAtCall * 100);
        const bold = p.bold ? " (a Bold Call)" : "";
        return {
          kind: "call",
          at,
          text: `Backed ${p.bucket} in ${where} for ${formatWal(p.stake)} WAL${bold}, when the crowd had it at ${pct}%.`,
          tags: [p.matchId, p.bucket],
        };
      }

      case "CallSettled": {
        const f = this.readModel.pots.getMatch(p.matchId)?.fixture;
        const where = f ? `${f.home} v ${f.away}` : p.matchId;
        const outcome = p.result === "WON" ? "came in" : "went down";
        const hard = p.difficulty >= 0.6 ? " against the odds" : p.difficulty <= 0.2 ? " — the safe one" : "";
        const gr = p.grDelta >= 0 ? `+${p.grDelta}` : `${p.grDelta}`;
        return {
          kind: "result",
          at,
          text: `${where} ${outcome}${hard}. P&L ${formatWal(p.pnlDelta)} WAL, GR ${gr}.`,
          tags: [p.matchId, p.result],
        };
      }

      case "CallVoided": {
        const f = this.readModel.pots.getMatch(p.matchId)?.fixture;
        const where = f ? `${f.home} v ${f.away}` : p.matchId;
        return { kind: "result", at, text: `Call on ${where} voided (${p.reason}); stake refunded.`, tags: [p.matchId] };
      }

      case "HotTakeDeclared":
        return { kind: "hot_take", at, text: `Hot take, on the record: "${p.text}"` };

      case "TierChanged": {
        const verb = p.direction === "PROMOTION" ? "Promoted" : "Demoted";
        return { kind: "milestone", at, text: `${verb}: ${p.from} → ${p.to} (GR ${p.grAt}).` };
      }

      case "TraitObserved":
        return { kind: "trait", at, text: `Pattern: ${p.label}. ${p.evidence}` };

      case "VerdictIssued":
        return { kind: "verdict", at, text: p.text };

      default:
        return null;
    }
  }
}
