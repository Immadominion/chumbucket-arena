/**
 * Mirrors the money to Walrus. The Gaffer's *memory* already lives on Walrus;
 * this puts the *money ledger* there too — every event that changes who owns what
 * WAL, written (encoded, in order) to a dedicated `${prefix}:ledger` namespace.
 *
 * Why it matters: today the balance-determining log is local SQLite — a promise.
 * Mirroring it to Walrus makes balances **independently recoverable** (re-read the
 * events, re-fold the projection) rather than trusting one server's disk. This is
 * what makes "on Walrus" true for the money, not only the memory.
 *
 * The full StoredEvent (meta + payload) is serialized with superjson, so bigint
 * FROST amounts and stream versions survive the round-trip exactly. Writes go
 * through a non-blocking queue so the command path never waits on Walrus.
 *
 * MVP transport: the MemWal (Walrus Memory) layer we already run. The production
 * upgrade is raw, publicly-readable Walrus blobs (@mysten/walrus) for trustless
 * third-party verification — but this already persists + recovers the ledger today.
 */

import superjson from "superjson";
import type { StoredEvent, DomainEventType } from "../domain/events.ts";
import type { MemoryStore } from "../core/memory/MemoryStore.ts";

// The events that move WAL on the ledger — folding these reconstructs every balance.
const LEDGER_EVENTS: ReadonlySet<DomainEventType> = new Set<DomainEventType>([
  "PlayerSigned",
  "Deposited",
  "Withdrawn",
  "WithdrawalInitiated",
  "WithdrawalSettled",
  "WithdrawalReversed",
  "WelcomeGranted",
  "HouseSeeded",
  "CallMade",
  "CallSettled",
  "CallVoided",
  "PotSettled", // the parimutuel result — so payouts are auditable, not just asserted
  // 1-v-1 challenge money legs — the same balance-determining facts for private escrows.
  "ChallengeStakeLocked",
  "ChallengeStakeSettled",
  "ChallengeStakeRefunded",
  "ChallengeSettled", // the escrow result — rake + payout auditable, like PotSettled
]);

export class WalrusLedgerMirror {
  private queue: Promise<unknown> = Promise.resolve();
  private mirrored = 0;

  constructor(
    private readonly memory: MemoryStore,
    private readonly namespace: string, // e.g. "gaffer:ledger"
  ) {}

  /** Attach to an event store; returns the unsubscribe handle. */
  attach(subscribe: (listener: (e: StoredEvent) => void) => () => void): () => void {
    return subscribe((e) => this.onEvent(e));
  }

  private onEvent(event: StoredEvent): void {
    if (!LEDGER_EVENTS.has(event.payload.type)) return;
    const text = superjson.stringify(event); // full StoredEvent — meta + payload, lossless
    this.queue = this.queue.then(() =>
      this.memory
        .remember(this.namespace, {
          kind: "ledger",
          at: event.meta.at,
          text,
          tags: [event.meta.streamId, event.payload.type],
        })
        .then(() => {
          this.mirrored += 1;
        })
        .catch((err) => console.error("[ledger] Walrus mirror failed:", err)),
    );
  }

  /** Resolve once all queued ledger writes have settled (for tests/shutdown). */
  async drain(): Promise<void> {
    await this.queue;
  }

  /** How many ledger events this process has mirrored to Walrus. */
  get count(): number {
    return this.mirrored;
  }
}

/**
 * Recover the mirrored ledger from Walrus: read every ledger memory back, decode
 * it to a StoredEvent, and return them ordered by stream + version — ready to
 * re-fold into balances. Proves the money is recoverable from Walrus alone.
 */
export async function recoverLedgerFromWalrus(
  memory: MemoryStore,
  namespace: string,
  limit = 5000,
): Promise<StoredEvent[]> {
  await memory.restore(namespace); // rebuild the index from Walrus blobs first
  const records = await memory.timeline(namespace, limit);
  const events = records
    .map((r) => {
      try {
        return superjson.parse<StoredEvent>(r.text);
      } catch {
        return null;
      }
    })
    .filter((e): e is StoredEvent => e !== null);
  return events.sort((a, b) =>
    a.meta.streamId === b.meta.streamId
      ? a.meta.version - b.meta.version
      : a.meta.streamId < b.meta.streamId
        ? -1
        : 1,
  );
}
