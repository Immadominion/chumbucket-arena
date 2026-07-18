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
import type { StoredEvent } from "../domain/events";
import type { MemoryStore } from "../core/memory/MemoryStore";
import type { ReadModel } from "../core/projections/ReadModel";
export declare class MemoryWriter {
    private readonly memory;
    private readonly readModel;
    private queue;
    constructor(memory: MemoryStore, readModel: ReadModel);
    /** Attach to an event store; returns the unsubscribe handle. */
    attach(subscribe: (listener: (e: StoredEvent) => void) => () => void): () => void;
    private onEvent;
    /** Resolve once all queued memory writes have settled. */
    drain(): Promise<void>;
    private describe;
}
