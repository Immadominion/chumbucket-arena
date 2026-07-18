/**
 * Helius webhook receiver.
 *
 * Helius may retry delivery, so every write must be idempotent. This first
 * reconciler slice confirms signatures that mobile already mirrored after MWA
 * signing; deeper instruction parsing/backfill can build on the same table.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app";
export interface HeliusTxSighting {
    signature: string;
    slot?: number;
    payload: Record<string, unknown>;
}
export declare function extractHeliusTxSightings(body: unknown): HeliusTxSighting[];
export declare function handleHeliusWebhook(app: App, req: IncomingMessage, res: ServerResponse): Promise<void>;
