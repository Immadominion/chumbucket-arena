/**
 * Bridges the event store's push subscription into an async generator that tRPC
 * subscriptions can yield from. Buffers events between pulls and shuts down
 * cleanly when the client disconnects (the subscription's abort signal fires).
 */
import type { StoredEvent } from "../domain/events";
import type { EventStore } from "../core/eventstore/EventStore";
export declare function streamEvents(store: EventStore, signal: AbortSignal | undefined, filter?: (e: StoredEvent) => boolean): AsyncGenerator<StoredEvent>;
