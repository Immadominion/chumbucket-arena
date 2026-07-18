/**
 * The chat transcript — every turn between a player and the Gaffer, folded from
 * the log so it survives reloads and lives on Walrus with the rest of the memory.
 */
import type { StoredEvent } from "../../domain/events";
import type { Wallet } from "../../domain/ids";
import type { Projection } from "./Projection";
export interface ChatEntry {
    message: string;
    reply: string;
    at: number;
}
export declare class ChatProjection implements Projection {
    readonly name = "chat";
    private readonly byWallet;
    apply(event: StoredEvent): void;
    /** Oldest → newest, last `limit` turns. */
    get(wallet: Wallet, limit?: number): ChatEntry[];
}
