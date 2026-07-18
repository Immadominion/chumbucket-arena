/**
 * In-memory event store — the dev/test substrate. Same contract as the
 * Walrus-backed store, so the entire system runs and is tested locally without
 * a network, then swaps to durable Walrus persistence behind the same interface.
 */
import type { DomainEvent, StoredEvent } from "../../domain/events";
import type { AppendOptions, EventListener, EventStore } from "./EventStore";
export declare class InMemoryEventStore implements EventStore {
    private readonly now;
    private readonly streams;
    private readonly log;
    private readonly listeners;
    constructor(now?: () => number);
    append(streamId: string, events: DomainEvent[], opts?: AppendOptions): Promise<StoredEvent[]>;
    readStream(streamId: string, fromVersion?: number): Promise<StoredEvent[]>;
    readAll(fromGlobal?: number): Promise<StoredEvent[]>;
    subscribe(listener: EventListener): () => void;
}
