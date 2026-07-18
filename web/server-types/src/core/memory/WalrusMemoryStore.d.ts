/**
 * MemoryStore backed by Walrus Memory (MemWal). Encodes our memory kind/tags/at
 * into the record metadata and reconstructs MemoryRecords on recall, degrading
 * gracefully if the relayer doesn't echo metadata back.
 */
import type { MemWalClient } from "./MemWalClient";
import type { MemoryRecord, MemoryStore } from "./MemoryStore";
export declare class WalrusMemoryStore implements MemoryStore {
    private readonly client;
    constructor(client: MemWalClient);
    remember(namespace: string, record: Omit<MemoryRecord, "score">): Promise<void>;
    recall(namespace: string, query: string, limit?: number): Promise<MemoryRecord[]>;
    timeline(namespace: string, limit?: number): Promise<MemoryRecord[]>;
    restore(namespace: string): Promise<{
        count: number;
    }>;
}
