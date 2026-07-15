/**
 * Bridges the event store's push subscription into an async generator that tRPC
 * subscriptions can yield from. Buffers events between pulls and shuts down
 * cleanly when the client disconnects (the subscription's abort signal fires).
 */

import type { StoredEvent } from "../domain/events.ts";
import type { EventStore } from "../core/eventstore/EventStore.ts";

export async function* streamEvents(
  store: EventStore,
  signal: AbortSignal | undefined,
  filter?: (e: StoredEvent) => boolean,
): AsyncGenerator<StoredEvent> {
  const buffer: StoredEvent[] = [];
  let wake: (() => void) | null = null;

  const unsubscribe = store.subscribe((e) => {
    if (!filter || filter(e)) {
      buffer.push(e);
      wake?.();
    }
  });

  try {
    while (!signal?.aborted) {
      if (buffer.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        wake = null;
      }
      while (buffer.length > 0) {
        const next = buffer.shift();
        if (next) yield next;
      }
    }
  } finally {
    unsubscribe();
  }
}
