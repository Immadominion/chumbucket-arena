/**
 * The Gaffer's memory — the semantic layer, distinct from the raw event log.
 *
 * The event store holds *what happened* in order. This holds *what it means* in
 * natural language, queryable by relevance: "you chase losses", "you swore
 * Argentina were finished". It is written when notable events occur and read
 * before a bet, after a result, and whenever the Gaffer speaks. On Walrus this
 * is MemWal; in tests it is a local keyword index. Same contract either way.
 */
export type MemoryKind = "call" | "result" | "hot_take" | "trait" | "milestone" | "verdict" | "ledger";
export interface MemoryRecord {
    text: string;
    kind: MemoryKind;
    at: number;
    tags?: string[];
    /** Relevance score in [0,1], present on recall results. */
    score?: number;
}
export interface MemoryStore {
    /** Write a memory into a player's namespace (persisted to Walrus). */
    remember(namespace: string, record: Omit<MemoryRecord, "score">): Promise<void>;
    /** Retrieve the most relevant memories for a query, most-relevant first. */
    recall(namespace: string, query: string, limit?: number): Promise<MemoryRecord[]>;
    /** Pull the recent timeline regardless of query (for the Dossier scrubber). */
    timeline(namespace: string, limit?: number): Promise<MemoryRecord[]>;
    /** Rebuild the search index for a namespace from its Walrus blobs. */
    restore(namespace: string): Promise<{
        count: number;
    }>;
}
