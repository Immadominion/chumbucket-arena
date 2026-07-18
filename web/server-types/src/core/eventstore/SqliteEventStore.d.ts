/**
 * Durable event store on SQLite (bun:sqlite — zero external deps). Same contract
 * as the in-memory store, so the system is identical above it; this is what lets
 * game state survive a restart or redeploy. The append-only log is the source of
 * truth on disk; projections rebuild from it on boot via ReadModel.hydrate.
 *
 * On Railway, point EVENT_LOG_PATH at a mounted volume. (Walrus mirroring of the
 * log is a later upgrade — this makes the operational store durable today.)
 */
import type { DomainEvent, StoredEvent } from "../../domain/events";
import type { AppendOptions, EventListener, EventStore } from "./EventStore";
export declare class SqliteEventStore implements EventStore {
    private readonly now;
    private readonly db;
    private readonly listeners;
    private readonly insertStmt;
    private readonly countStmt;
    private readonly streamStmt;
    private readonly allStmt;
    constructor(path?: string, now?: () => number);
    append(streamId: string, events: DomainEvent[], opts?: AppendOptions): Promise<StoredEvent[]>;
    private insertTxn;
    readStream(streamId: string, fromVersion?: number): Promise<StoredEvent[]>;
    readAll(fromGlobal?: number): Promise<StoredEvent[]>;
    subscribe(listener: EventListener): () => void;
    close(): void;
}
