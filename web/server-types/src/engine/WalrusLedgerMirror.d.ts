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
import type { StoredEvent } from "../domain/events";
import type { MemoryStore } from "../core/memory/MemoryStore";
export declare class WalrusLedgerMirror {
    private readonly memory;
    private readonly namespace;
    private queue;
    private mirrored;
    constructor(memory: MemoryStore, namespace: string);
    /** Attach to an event store; returns the unsubscribe handle. */
    attach(subscribe: (listener: (e: StoredEvent) => void) => () => void): () => void;
    private onEvent;
    /** Resolve once all queued ledger writes have settled (for tests/shutdown). */
    drain(): Promise<void>;
    /** How many ledger events this process has mirrored to Walrus. */
    get count(): number;
}
/**
 * Recover the mirrored ledger from Walrus: read every ledger memory back, decode
 * it to a StoredEvent, and return them ordered by stream + version — ready to
 * re-fold into balances. Proves the money is recoverable from Walrus alone.
 */
export declare function recoverLedgerFromWalrus(memory: MemoryStore, namespace: string, limit?: number): Promise<StoredEvent[]>;
