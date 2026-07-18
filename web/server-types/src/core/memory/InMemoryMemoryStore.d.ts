/**
 * In-memory memory store for dev/tests. Recall is a simple token-overlap score —
 * enough to prove the loop (the Gaffer pulls the right past memory before a bet)
 * without a network. The Walrus adapter swaps in real semantic recall.
 */
import type { MemoryRecord, MemoryStore } from "./MemoryStore";
export declare class InMemoryMemoryStore implements MemoryStore {
    private readonly byNamespace;
    remember(namespace: string, record: Omit<MemoryRecord, "score">): Promise<void>;
    recall(namespace: string, query: string, limit?: number): Promise<MemoryRecord[]>;
    timeline(namespace: string, limit?: number): Promise<MemoryRecord[]>;
    restore(namespace: string): Promise<{
        count: number;
    }>;
}
