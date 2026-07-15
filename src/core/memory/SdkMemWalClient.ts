/**
 * The real Walrus Memory transport — wraps the official `@mysten-incubation/memwal`
 * SDK behind our MemWalClient port. Auth is a single Ed25519 *delegate key* the
 * product holds (no owner wallet at runtime); the relayer (a TEE) does the
 * encryption, embedding, and Walrus storage server-side. Provision the delegate
 * key once with scripts/memwal-setup.ts, then set MEMWAL_PRIVATE_KEY + ACCOUNT_ID.
 *
 * Writes are fire-and-accept (the relayer finishes embedding/uploading in the
 * background) so the command path is never blocked on Walrus; recall is a
 * semantic search returning decrypted plaintext.
 */

import { MemWal } from "@mysten-incubation/memwal";
import type { MemWalClient, MemWalRecallHit } from "./MemWalClient.ts";

export interface SdkMemWalConfig {
  privateKey: string; // Ed25519 delegate key (hex)
  accountId: string; // Walrus Memory account object id (0x…)
  serverUrl?: string; // relayer URL (default: the SDK's hosted relayer)
}

export class SdkMemWalClient implements MemWalClient {
  private readonly mw: MemWal;

  constructor(cfg: SdkMemWalConfig) {
    this.mw = MemWal.create({
      key: cfg.privateKey,
      accountId: cfg.accountId,
      ...(cfg.serverUrl ? { serverUrl: cfg.serverUrl } : {}),
    });
  }

  async remember(namespace: string, text: string): Promise<void> {
    // Returns once the relayer accepts the job; it indexes in the background.
    await this.mw.remember(text, namespace);
  }

  async recall(namespace: string, query: string, limit: number): Promise<MemWalRecallHit[]> {
    const result = await this.mw.recall({ query: query.trim() || "memory", limit, namespace });
    return result.results.map((m) => ({
      text: m.text,
      // distance is a closeness metric (lower = nearer); fold to a 0..1 score.
      score: 1 / (1 + Math.max(0, m.distance)),
    }));
  }

  async restore(namespace: string, limit: number): Promise<{ count: number }> {
    const r = await this.mw.restore(namespace, limit);
    return { count: r.restored + r.skipped };
  }
}
