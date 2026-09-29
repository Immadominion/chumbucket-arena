import type { WriteQueue } from "../prediction/pgrest.ts";

/** A failed shared writer cannot serve social reads from its ahead-of-DB mirror.
 *  Wait for in-flight writes before the process is restarted; only a fresh
 *  hydrate from Postgres may remove the failure quarantine. */
export async function durableWriterNeedsRestart(
  queue: Pick<WriteQueue, "failures" | "drain">,
): Promise<boolean> {
  if (queue.failures.length === 0) return false;
  try {
    await queue.drain();
  } catch {
    // A non-draining queue is also unsafe to continue serving. Its raw error
    // is deliberately not logged here; the caller emits a fixed diagnostic.
    return true;
  }
  return queue.failures.length > 0;
}
