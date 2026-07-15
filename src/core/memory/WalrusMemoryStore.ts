/**
 * MemoryStore backed by Walrus Memory (MemWal). Encodes our memory kind/tags/at
 * into the record metadata and reconstructs MemoryRecords on recall, degrading
 * gracefully if the relayer doesn't echo metadata back.
 */

import type { MemWalClient, MemWalRecallHit } from "./MemWalClient.ts";
import type { MemoryKind, MemoryRecord, MemoryStore } from "./MemoryStore.ts";

const decode = (hit: MemWalRecallHit): MemoryRecord => {
  const meta = hit.metadata ?? {};
  const record: MemoryRecord = {
    text: hit.text,
    kind: (typeof meta.kind === "string" ? (meta.kind as MemoryKind) : "call"),
    at: typeof meta.at === "number" ? meta.at : (hit.createdAt ?? Date.now()),
  };
  if (Array.isArray(meta.tags)) record.tags = meta.tags as string[];
  if (hit.score !== undefined) record.score = hit.score;
  return record;
};

export class WalrusMemoryStore implements MemoryStore {
  constructor(private readonly client: MemWalClient) {}

  async remember(namespace: string, record: Omit<MemoryRecord, "score">): Promise<void> {
    await this.client.remember(namespace, record.text, {
      kind: record.kind,
      at: record.at,
      tags: record.tags ?? [],
    });
  }

  async recall(namespace: string, query: string, limit = 8): Promise<MemoryRecord[]> {
    const hits = await this.client.recall(namespace, query, limit);
    return hits.map(decode);
  }

  async timeline(namespace: string, limit = 20): Promise<MemoryRecord[]> {
    // MemWal recall with an empty/broad query returns the namespace's memories;
    // we sort by recency client-side.
    const hits = await this.client.recall(namespace, "", limit);
    return hits.map(decode).sort((a, b) => b.at - a.at);
  }

  async restore(namespace: string): Promise<{ count: number }> {
    return this.client.restore(namespace, 500);
  }
}
