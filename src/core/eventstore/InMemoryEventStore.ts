/**
 * In-memory event store — the dev/test substrate. Same contract as the
 * Walrus-backed store, so the entire system runs and is tested locally without
 * a network, then swaps to durable Walrus persistence behind the same interface.
 */

import { DomainError } from "../../domain/errors.ts";
import type { DomainEvent, StoredEvent } from "../../domain/events.ts";
import { newEventId } from "../../domain/ids.ts";
import type { AppendOptions, EventListener, EventStore } from "./EventStore.ts";

export class InMemoryEventStore implements EventStore {
  private readonly streams = new Map<string, StoredEvent[]>();
  private readonly log: StoredEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async append(
    streamId: string,
    events: DomainEvent[],
    opts?: AppendOptions,
  ): Promise<StoredEvent[]> {
    const current = this.streams.get(streamId) ?? [];
    if (opts?.expectedVersion !== undefined && opts.expectedVersion !== current.length) {
      throw new DomainError(
        "CONFLICT",
        `stream ${streamId} is at v${current.length}, expected v${opts.expectedVersion}`,
        { streamId, expected: opts.expectedVersion, actual: current.length },
      );
    }
    const at = this.now();
    const stored: StoredEvent[] = events.map((payload, i) => ({
      meta: { id: newEventId(), streamId, version: current.length + i, at },
      payload,
    }));

    this.streams.set(streamId, [...current, ...stored]);
    this.log.push(...stored);

    // Notify listeners after the write is committed. A faulty listener must not
    // corrupt the append; projections that throw are isolated and logged.
    for (const e of stored) {
      for (const listener of this.listeners) {
        try {
          await listener(e);
        } catch (err) {
          console.error(`[eventstore] listener failed on ${e.payload.type}:`, err);
        }
      }
    }
    return stored;
  }

  async readStream(streamId: string, fromVersion = 0): Promise<StoredEvent[]> {
    return (this.streams.get(streamId) ?? []).slice(fromVersion);
  }

  async readAll(fromGlobal = 0): Promise<StoredEvent[]> {
    return this.log.slice(fromGlobal);
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
