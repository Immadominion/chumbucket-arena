/**
 * In-memory memory store for dev/tests. Recall is a simple token-overlap score —
 * enough to prove the loop (the Gaffer pulls the right past memory before a bet)
 * without a network. The Walrus adapter swaps in real semantic recall.
 */

import type { MemoryRecord, MemoryStore } from "./MemoryStore.ts";

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);

export class InMemoryMemoryStore implements MemoryStore {
  private readonly byNamespace = new Map<string, MemoryRecord[]>();

  async remember(namespace: string, record: Omit<MemoryRecord, "score">): Promise<void> {
    const list = this.byNamespace.get(namespace) ?? [];
    list.push({ ...record });
    this.byNamespace.set(namespace, list);
  }

  async recall(namespace: string, query: string, limit = 8): Promise<MemoryRecord[]> {
    const records = this.byNamespace.get(namespace) ?? [];
    const q = new Set(tokenize(query));
    if (q.size === 0) return this.timeline(namespace, limit);

    const scored = records.map((r) => {
      const tokens = tokenize(r.text);
      const overlap = tokens.filter((t) => q.has(t)).length;
      const recency = 1 / (1 + (Date.now() - r.at) / (1000 * 60 * 60 * 24)); // day-decay
      const score = overlap / Math.max(q.size, 1) + recency * 0.15;
      return { ...r, score };
    });

    return scored
      .filter((r) => (r.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }

  async timeline(namespace: string, limit = 20): Promise<MemoryRecord[]> {
    const records = this.byNamespace.get(namespace) ?? [];
    return [...records].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  async restore(namespace: string): Promise<{ count: number }> {
    return { count: (this.byNamespace.get(namespace) ?? []).length };
  }
}
