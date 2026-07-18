/**
 * The event store: an append-only log of immutable facts, partitioned into
 * streams (one per player, one per match). Everything else in the system is a
 * projection of this log. The canonical copy lives on Walrus; an adapter may
 * cache it locally for fast replay.
 */
import type { DomainEvent, StoredEvent } from "../../domain/events";
export interface AppendOptions {
    /**
     * Optimistic concurrency. The version the caller believes the stream is at
     * (its current length). If it doesn't match, the append is rejected with a
     * CONFLICT — the caller should re-read and retry. The player actor serialises
     * writes per stream, so this is a backstop, not the primary guard.
     */
    expectedVersion?: number;
}
export type EventListener = (event: StoredEvent) => void | Promise<void>;
export interface EventStore {
    /** Append events to a stream, assigning per-stream version + timestamp. */
    append(streamId: string, events: DomainEvent[], opts?: AppendOptions): Promise<StoredEvent[]>;
    /** Read one stream from a version (inclusive), in order. */
    readStream(streamId: string, fromVersion?: number): Promise<StoredEvent[]>;
    /** Global append-ordered read across all streams — for projection rebuilds. */
    readAll(fromGlobal?: number): Promise<StoredEvent[]>;
    /** Live tail: fires for every appended event in global order. */
    subscribe(listener: EventListener): () => void;
}
