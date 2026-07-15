/**
 * Helius webhook receiver.
 *
 * Helius may retry delivery, so every write must be idempotent. This first
 * reconciler slice confirms signatures that mobile already mirrored after MWA
 * signing; deeper instruction parsing/backfill can build on the same table.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { App } from "../app.ts";
import { DEFAULT_ARENA_PROGRAM_ID, extractArenaInstructions } from "./ArenaInstructionParser.ts";

export interface HeliusTxSighting {
  signature: string;
  slot?: number;
  payload: Record<string, unknown>;
}

export function extractHeliusTxSightings(body: unknown): HeliusTxSighting[] {
  const rows = Array.isArray(body)
    ? body
    : isObject(body) && Array.isArray(body.transactions)
      ? body.transactions
      : [body];

  const out: HeliusTxSighting[] = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    const nestedTx = isObject(row.transaction) ? row.transaction : undefined;
    const signature =
      stringVal(row.signature) ??
      stringVal(row.transactionSignature) ??
      stringVal(row.txSignature) ??
      (nestedTx ? stringVal(nestedTx.signature) : undefined);
    if (!signature) continue;
    const slot =
      numberVal(row.slot) ??
      numberVal(row.transactionSlot) ??
      (nestedTx ? numberVal(nestedTx.slot) : undefined);
    out.push({
      signature,
      ...(slot != null ? { slot } : {}),
      payload: row,
    });
  }
  return out;
}

export async function handleHeliusWebhook(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!authorized(app.config.indexer?.heliusWebhookAuth, req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid json" }));
    return;
  }

  const sightings = extractHeliusTxSightings(parsed);
  const results = [];
  for (const s of sightings) {
    const arenaInstructions = extractArenaInstructions(
      s.payload,
      app.config.onchainKeeper?.programId ?? DEFAULT_ARENA_PROGRAM_ID,
    );
    results.push(
      await app.social.confirmPredictionSignature({
        source: "helius",
        txSignature: s.signature,
        ...(s.slot != null ? { slot: s.slot } : {}),
        payload: {
          ...s.payload,
          ...(arenaInstructions.length > 0 ? { arenaInstructions } : {}),
        },
      }),
    );
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, seen: sightings.length, results }));
}

function authorized(secret: string | undefined, req: IncomingMessage): boolean {
  if (!secret) return true;
  const header = first(req.headers["x-helius-auth"]) ?? bearer(first(req.headers.authorization));
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(v: string | undefined): string | undefined {
  return v?.startsWith("Bearer ") ? v.slice(7) : undefined;
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function stringVal(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numberVal(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
