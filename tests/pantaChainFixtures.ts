/**
 * Test-only builders for Panta program accounts and a fake Solana RPC.
 *
 * `encodePantaEvent` writes the same `Event` prefix layout
 * src/prediction/PantaProgram.ts reads, so state transitions (a market
 * resolving, being cancelled, going under review) can be exercised on
 * synthetic accounts. The decoder itself is pinned to REAL mainnet bytes in
 * ./fixtures/pantaChainAccounts.ts; these builders never replace that.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { MAINNET_GENESIS_HASH } from "../src/prediction/PantaChain.ts";
import { PANTA_EVENT_DISCRIMINATOR, PANTA_PROGRAM_ID } from "../src/prediction/PantaProgram.ts";
import type { FetchLike } from "../src/prediction/http.ts";

export interface SyntheticEvent {
  creator?: PublicKey;
  question: string;
  rule?: string;
  sources?: string[];
  startTime?: number; endTime: number; resolutionTime?: number; createdAt?: number;
  resolvedAt?: number; cancelledAt?: number; claimableAt?: number; reviewExpiresAt?: number;
  lastYesPrice?: bigint;
  isActive?: boolean; isGraduated?: boolean; isResolved?: boolean; isCancelled?: boolean; yesWins?: boolean;
  pendingReview?: 0 | 1 | 2;
  marketType?: 0 | 1;
}

export const SYNTHETIC_CREATOR = new PublicKey(Buffer.alloc(32, 7));

class Writer {
  private readonly parts: Buffer[] = [];
  bytes(b: Uint8Array) { this.parts.push(Buffer.from(b)); }
  u8(v: number) { this.parts.push(Buffer.from([v])); }
  bool(v: boolean) { this.u8(v ? 1 : 0); }
  i64(v: number) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); this.parts.push(b); }
  u64(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); this.parts.push(b); }
  u128(v: bigint) { const b = Buffer.alloc(16); b.writeBigUInt64LE(v & ((1n << 64n) - 1n)); b.writeBigUInt64LE(v >> 64n, 8); this.parts.push(b); }
  str(s: string) { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); this.parts.push(l, b); }
  done(pad = 2947) { const out = Buffer.concat(this.parts); return out.length >= pad ? out : Buffer.concat([out, Buffer.alloc(pad - out.length)]); }
}

/** The address the program would give this event for a quote asset. */
export function eventAddress(question: string, quote: "SOL" | "USDC" = "SOL", creator = SYNTHETIC_CREATOR): string {
  const hash = createHash("sha256").update(question, "utf8").digest();
  return PublicKey.findProgramAddressSync([Buffer.from(quote === "SOL" ? "event" : "event_usdc"), creator.toBuffer(), hash],
    new PublicKey(PANTA_PROGRAM_ID))[0].toBase58();
}

export function encodePantaEvent(e: SyntheticEvent): Buffer {
  const w = new Writer();
  w.bytes(PANTA_EVENT_DISCRIMINATOR);
  w.bytes((e.creator ?? SYNTHETIC_CREATOR).toBuffer());
  for (const t of [e.startTime ?? e.endTime - 86_400, e.endTime, e.resolutionTime ?? e.endTime, e.createdAt ?? e.endTime - 172_800,
    e.resolvedAt ?? 0, e.cancelledAt ?? 0]) w.i64(t);
  for (let i = 0; i < 4; i++) w.u128(5_000_000_000n);
  w.u128(e.lastYesPrice ?? 500_000_000n);
  for (let i = 0; i < 3; i++) w.u128(0n);
  w.u64(0n);
  for (let i = 0; i < 5; i++) w.u128(0n);
  w.i64(e.claimableAt ?? 0);
  w.u128(0n);
  w.str(e.question);
  w.str(e.rule ?? "Resolve YES, if the synthetic condition holds. Else resolve NO.");
  const sources = e.sources ?? ["synthetic-source"];
  const n = Buffer.alloc(4); n.writeUInt32LE(sources.length); w.bytes(n);
  for (const s of sources) w.str(s);
  w.u128(0n);
  w.u8(255); w.u8(254); w.u8(253);
  w.bool(e.isActive ?? true); w.bool(e.isGraduated ?? true); w.bool(e.isResolved ?? false);
  w.bool(e.isCancelled ?? false); w.bool(e.yesWins ?? false); w.bool(false);
  w.u8(e.pendingReview ?? 0); w.u8(0); w.u8(e.marketType ?? 0);
  w.i64(e.startTime ?? e.endTime - 86_400); w.bool(false); w.i64(e.endTime - 3_600); w.i64(e.reviewExpiresAt ?? 0);
  w.bool(false); w.bool(false); w.u128(0n); w.u128(0n);
  return w.done();
}

export interface FakeAccount { owner: string; data: Buffer }

/** A Solana JSON-RPC that serves `accounts` and records what it was asked. */
export function fakeSolanaRpc(accounts: Map<string, FakeAccount>, opts: { genesis?: string; slot?: number } = {}) {
  const asked: { method: string; addresses: string[] }[] = [];
  let fail: ((method: string) => Response | null) | null = null;
  const encode = (a: FakeAccount | undefined) => a
    ? { data: [a.data.toString("base64"), "base64"], owner: a.owner, lamports: 1, executable: false, rentEpoch: 0, space: a.data.length }
    : null;
  const fetchImpl: FetchLike = async (_input, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const failure = fail?.(method);
    if (failure) return failure;
    const slot = opts.slot ?? 400_000_000;
    let result: unknown;
    if (method === "getGenesisHash") { asked.push({ method, addresses: [] }); result = opts.genesis ?? MAINNET_GENESIS_HASH; }
    else if (method === "getProgramAccounts") {
      asked.push({ method, addresses: [] });
      result = [...accounts].filter(([, a]) => a.owner === PANTA_PROGRAM_ID &&
        PANTA_EVENT_DISCRIMINATOR.every((b, i) => a.data[i] === b))
        .map(([pubkey]) => ({ pubkey, account: { data: ["", "base64"], owner: PANTA_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0, space: 0 } }));
    } else if (method === "getMultipleAccounts") {
      const keys = params[0] as string[];
      asked.push({ method, addresses: keys });
      result = { context: { slot }, value: keys.map(k => encode(accounts.get(k))) };
    } else if (method === "getAccountInfo") {
      const key = params[0] as string;
      asked.push({ method, addresses: [key] });
      result = { context: { slot }, value: encode(accounts.get(key)) };
    } else throw new Error(`unexpected RPC ${method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, asked, failWith: (f: typeof fail) => { fail = f; } };
}
