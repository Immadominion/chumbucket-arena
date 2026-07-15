/**
 * The chat transcript — every turn between a player and the Gaffer, folded from
 * the log so it survives reloads and lives on Walrus with the rest of the memory.
 */

import type { StoredEvent } from "../../domain/events.ts";
import type { Wallet } from "../../domain/ids.ts";
import type { Projection } from "./Projection.ts";

export interface ChatEntry {
  message: string; // the player's line
  reply: string; // the Gaffer's reply
  at: number;
}

const streamWallet = (streamId: string): Wallet | undefined =>
  streamId.startsWith("gaffer:") && !streamId.startsWith("gaffer:match:")
    ? (streamId.slice("gaffer:".length) as Wallet)
    : undefined;

export class ChatProjection implements Projection {
  readonly name = "chat";
  private readonly byWallet = new Map<Wallet, ChatEntry[]>();

  apply(event: StoredEvent): void {
    if (event.payload.type !== "ChatExchanged") return;
    const w = streamWallet(event.meta.streamId);
    if (!w) return;
    const list = this.byWallet.get(w) ?? [];
    list.push({ message: event.payload.message, reply: event.payload.reply, at: event.meta.at });
    this.byWallet.set(w, list);
  }

  /** Oldest → newest, last `limit` turns. */
  get(wallet: Wallet, limit = 50): ChatEntry[] {
    return (this.byWallet.get(wallet) ?? []).slice(-limit);
  }
}
