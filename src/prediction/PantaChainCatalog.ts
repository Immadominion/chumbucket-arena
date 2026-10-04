/**
 * Read-only Solana RPC reader for Panta's SOL-quoted markets (./PantaProgram.ts
 * says why they exist and how an account is trusted). Never signs, never
 * writes, never sees a user key.
 *
 * COST. Discovery lists the program's Event accounts with a zero-length data
 * slice (addresses only, a few KB), then reads full accounts only for
 * addresses it has not classified yet and for SOL markets that are not final.
 * The quote asset of an address never changes, so a USDC account is read once
 * per process and never again; a settled SOL market is not re-listed. A pass
 * therefore costs two small RPC calls once the first one has classified the
 * catalog (~600 KB, once).
 *
 * CATEGORY. The program stores no category. panta.market's own public registry
 * (the backend its website reads) supplies the display category; it is fetched
 * once per market, strictly validated, and is display metadata only. Without
 * it a market is still listed, as "other".
 *
 * FAILURE. A transient RPC fault fails the read (and is retried with backoff).
 * One account that does not decode, or whose address does not derive from its
 * question, is set aside and reported, never served — it must not hide every
 * other market, and it must not be guessed at.
 */
import { z } from "zod";
import { utils } from "@coral-xyz/anchor";
import { retry, type RetryOptions } from "./backoff.ts";
import { systemClock, type Clock } from "./clock.ts";
import { VenueError, isVenueError } from "./errors.ts";
import type { FetchLike } from "./http.ts";
import { MAINNET_GENESIS_HASH } from "./PantaChain.ts";
import { PANTA_EVENT_DISCRIMINATOR, PANTA_PROGRAM_ID, decodePantaEvent, pantaChainRead, pantaEventResolution,
  pantaEventStatus, pantaQuoteAsset, type PantaChainRead, type PantaQuoteAsset } from "./PantaProgram.ts";
import type { RawPayload } from "./PredictionVenue.ts";

export const PANTA_REGISTRY_URL = "https://production-api.balr.fun/api/v1/events/registry";
const READ_REUSE_MS = 15_000;
const LIST_REUSE_MS = 30_000;
const RETRY_UNSERVED_MS = 600_000;
const CATEGORY_RETRY_MS = 600_000;
const MULTIPLE_ACCOUNTS_LIMIT = 100;
const MAX_CATEGORY_LOOKUPS_PER_PASS = 12;
const MAX_HELD_READS = 512;

export interface PantaChainCatalogConfig {
  rpcUrl: string;
  fetchImpl?: FetchLike;
  clock?: Clock;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  /** panta.market's registry, for display categories. null disables lookups. */
  registryUrl?: string | null;
  /** Told about an account that was set aside. Never given the RPC URL. */
  onUnserved?: (address: string, error: unknown) => void;
}

const accountSchema = z.object({
  data: z.tuple([z.string(), z.literal("base64")]),
  owner: z.string(),
}).passthrough();
const multipleSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
  value: z.array(accountSchema.nullable()),
});
const singleSchema = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }).passthrough(),
  value: accountSchema.nullable(),
});
const addressesSchema = z.array(z.object({ pubkey: z.string().min(32).max(44) }).passthrough());
const registrySchema = z.object({
  success: z.literal(true),
  data: z.object({ eventPda: z.string(), Category: z.string().nullable().optional() }).passthrough(),
});

type Class = PantaQuoteAsset | "UNSERVED";

export class PantaChainCatalog {
  private readonly clock: Clock;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly registryUrl: string | null;
  private mainnet: Promise<void> | undefined;
  /** Immutable facts: an address's quote asset, by its own derivation. */
  private readonly classes = new Map<string, Class>();
  private readonly unservedAt = new Map<string, number>();
  /** SOL markets whose result the program has published. Not re-listed. */
  private readonly final = new Set<string>();
  private readonly reads = new Map<string, PantaChainRead>();
  private readonly categories = new Map<string, string | null>();
  private readonly categoryTriedAt = new Map<string, number>();
  private listed: { at: number; reads: PantaChainRead[] } | undefined;
  private listing: Promise<PantaChainRead[]> | undefined;
  /** Every address the program holds an Event account at, as last listed. */
  private eventAddresses: { at: number; set: ReadonlySet<string> } | undefined;
  private addressListing: Promise<ReadonlySet<string>> | undefined;

  constructor(private readonly config: PantaChainCatalogConfig) {
    const url = new URL(config.rpcUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new VenueError("VENUE_MISCONFIGURED", "Panta chain catalog requires a secure mainnet RPC", { venue: "panta" });
    }
    this.clock = config.clock ?? systemClock;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = Math.min(20_000, Math.max(1, config.timeoutMs ?? 10_000));
    this.registryUrl = config.registryUrl === undefined ? PANTA_REGISTRY_URL : config.registryUrl;
  }

  /** The quote asset an address was proven to have, if it has been read. */
  quoteOf(address: string): PantaQuoteAsset | undefined {
    const c = this.classes.get(address);
    return c === "SOL" || c === "USDC" ? c : undefined;
  }

  /** The evidence of the latest read of a SOL market, if one is held. */
  rawPayload(address: string): RawPayload | undefined {
    return this.reads.get(address)?.raw;
  }

  /**
   * Every SOL-quoted market that is not final, read within the last
   * LIST_REUSE_MS. Concurrent callers share one read, so a public route that
   * reaches the catalog cannot turn phone traffic into RPC traffic. Accounts
   * already known to be USDC are skipped without a read.
   */
  async listSolMarkets(): Promise<PantaChainRead[]> {
    if (this.listed && this.clock.now() - this.listed.at < LIST_REUSE_MS) return this.listed.reads;
    this.listing ??= this.readSolMarkets().then(reads => {
      this.listed = { at: this.clock.now(), reads };
      return reads;
    }).finally(() => { this.listing = undefined; });
    return this.listing;
  }

  private async readSolMarkets(): Promise<PantaChainRead[]> {
    await this.assertMainnet();
    const now = this.clock.now();
    const addresses = await this.programEventAddresses();
    const wanted = addresses.filter(address => {
      const c = this.classes.get(address);
      if (c === undefined) return true;
      if (c === "UNSERVED") return now - (this.unservedAt.get(address) ?? 0) >= RETRY_UNSERVED_MS;
      return c === "SOL" && !this.final.has(address);
    });
    const fetched = await this.readAccounts(wanted);
    const sol = fetched.filter(a => this.classify(a.address, a.data) === "SOL");
    // Categories only for markets that will be listed: a settled market is
    // never shown in discovery, and the lookup budget is per pass.
    await this.lookUpCategories(sol.filter(a => listable(a.data, this.clock.now())).map(a => a.address));
    const out: PantaChainRead[] = [];
    for (const a of sol) {
      const read = this.build(a);
      if (!read) continue;
      if (pantaEventResolution(read.event, this.clock.now())) this.final.add(read.address);
      out.push(read);
    }
    return out;
  }

  /** One SOL market, freshly read (or reused within 15s). VENUE_NOT_FOUND when
   *  the address is not a SOL-quoted Panta event.
   *
   *  Public reads can name any address (predictions.getMarket falls back here
   *  when the partner API does not know one). Only an address the program
   *  lists as an Event account is ever read in full, so such a request cannot
   *  make the BFF download an arbitrary account, log it, or grow its maps. */
  async readSolMarket(address: string): Promise<PantaChainRead> {
    const held = this.reads.get(address);
    if (held && this.clock.now() - held.fetchedAt < READ_REUSE_MS) return held;
    if (this.quoteOf(address) === "USDC") throw notSol();
    await this.assertMainnet();
    if (this.quoteOf(address) !== "SOL" && !(await this.isProgramEvent(address))) throw notSol();
    const [account] = await this.readAccounts([address]);
    if (!account || this.classify(address, account.data) !== "SOL") throw notSol();
    await this.lookUpCategories([address]);
    const read = this.build(account);
    if (!read) throw notSol();
    return read;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private classify(address: string, data: Uint8Array): Class {
    const known = this.classes.get(address);
    if (known === "SOL" || known === "USDC") return known;
    try {
      const quote = pantaQuoteAsset(address, decodePantaEvent(data));
      if (!quote) throw new VenueError("VENUE_SCHEMA", "panta: event address does not derive from its question", { venue: "panta" });
      this.classes.set(address, quote);
      this.unservedAt.delete(address);
      return quote;
    } catch (error) {
      this.setAside(address, error);
      return "UNSERVED";
    }
  }

  private build(a: { address: string; owner: string; data: Uint8Array; slot: number }): PantaChainRead | null {
    try {
      const read = pantaChainRead({ ...a, fetchedAt: this.clock.now(), category: this.categories.get(a.address) ?? null });
      this.reads.delete(a.address);
      this.reads.set(a.address, read);
      if (this.reads.size > MAX_HELD_READS) this.reads.delete(this.reads.keys().next().value!);
      return read;
    } catch (error) {
      this.classes.delete(a.address);
      this.setAside(a.address, error);
      return null;
    }
  }

  private setAside(address: string, error: unknown): void {
    this.classes.set(address, "UNSERVED");
    this.unservedAt.set(address, this.clock.now());
    this.reads.delete(address);
    this.config.onUnserved?.(address, error);
  }

  private async programEventAddresses(): Promise<string[]> {
    const result = await this.rpc("getProgramAccounts", [PANTA_PROGRAM_ID, {
      encoding: "base64", dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(PANTA_EVENT_DISCRIMINATOR) } }],
    }]);
    const parsed = addressesSchema.safeParse(result);
    if (!parsed.success) throw rpcShape("program account list");
    const list = [...new Set(parsed.data.map(row => row.pubkey))].sort();
    this.eventAddresses = { at: this.clock.now(), set: new Set(list) };
    return list;
  }

  /** Whether the program holds an Event account at `address`, from the
   *  address-only list (a few KB). A miss re-lists at most every
   *  LIST_REUSE_MS, and concurrent misses share one listing. */
  private async isProgramEvent(address: string): Promise<boolean> {
    const held = this.eventAddresses;
    if (held && (held.set.has(address) || this.clock.now() - held.at < LIST_REUSE_MS)) return held.set.has(address);
    this.addressListing ??= this.programEventAddresses()
      .then(() => this.eventAddresses!.set)
      .finally(() => { this.addressListing = undefined; });
    return (await this.addressListing).has(address);
  }

  private async readAccounts(addresses: string[]): Promise<{ address: string; owner: string; data: Uint8Array; slot: number }[]> {
    const out: { address: string; owner: string; data: Uint8Array; slot: number }[] = [];
    for (let i = 0; i < addresses.length; i += MULTIPLE_ACCOUNTS_LIMIT) {
      const chunk = addresses.slice(i, i + MULTIPLE_ACCOUNTS_LIMIT);
      const result = chunk.length === 1
        ? await this.rpc("getAccountInfo", [chunk[0], { encoding: "base64", commitment: "confirmed" }])
        : await this.rpc("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
      const parsed = chunk.length === 1 ? singleSchema.safeParse(result) : multipleSchema.safeParse(result);
      if (!parsed.success) throw rpcShape("account read");
      const values = Array.isArray(parsed.data.value) ? parsed.data.value : [parsed.data.value];
      if (values.length !== chunk.length) throw rpcShape("account read length");
      values.forEach((value, j) => {
        if (!value) return; // closed account: nothing to serve
        out.push({ address: chunk[j]!, owner: value.owner, data: Buffer.from(value.data[0], "base64"), slot: parsed.data.context.slot });
      });
    }
    return out;
  }

  private async lookUpCategories(addresses: string[]): Promise<void> {
    if (!this.registryUrl) return;
    const now = this.clock.now();
    const due = addresses.filter(a => !this.categories.has(a) && now - (this.categoryTriedAt.get(a) ?? -Infinity) >= CATEGORY_RETRY_MS)
      .slice(0, MAX_CATEGORY_LOOKUPS_PER_PASS);
    await Promise.all(due.map(async address => {
      this.categoryTriedAt.set(address, now);
      try {
        const response = await this.fetchImpl(`${this.registryUrl}/${address}`, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;
        const text = await response.text();
        if (text.length > 65_536) return;
        const parsed = registrySchema.safeParse(JSON.parse(text));
        if (!parsed.success || parsed.data.data.eventPda !== address) return;
        const category = parsed.data.data.Category?.trim().toLowerCase() ?? null;
        this.categories.set(address, category && /^[a-z0-9][a-z0-9-]{0,47}$/.test(category) ? category : null);
      } catch { /* display metadata only: the market is listed as "other" */ }
    }));
  }

  private async assertMainnet(): Promise<void> {
    this.mainnet ??= this.rpc("getGenesisHash", []).then(genesis => {
      if (genesis !== MAINNET_GENESIS_HASH) throw new Error("not mainnet");
    }).catch(error => {
      this.mainnet = undefined;
      if (isVenueError(error) && error.retryable) throw error;
      throw new VenueError("VENUE_MISCONFIGURED", "Panta chain catalog RPC is not Solana mainnet", { venue: "panta" });
    });
    await this.mainnet;
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    return retry(async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.rpcUrl, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      } catch {
        // Never echo the RPC URL: it can carry a provider key.
        throw new VenueError("VENUE_UNAVAILABLE", "Solana RPC read failed", { venue: "panta" });
      }
      if (!response.ok) {
        const code = response.status === 429 ? "VENUE_RATE_LIMITED" : response.status >= 500 || response.status === 408
          ? "VENUE_UNAVAILABLE" : "VENUE_BAD_REQUEST";
        throw new VenueError(code, `Solana RPC refused ${method} (HTTP ${response.status})`, { venue: "panta" });
      }
      let body: { result?: unknown; error?: { code?: unknown } };
      try { body = await response.json() as typeof body; }
      catch { throw rpcShape("JSON"); }
      if (body.error) {
        // -32005 / -32016 style node lag and rate limits are transient.
        throw new VenueError("VENUE_UNAVAILABLE", `Solana RPC ${method} answered an error`, { venue: "panta" });
      }
      if (!("result" in body)) throw rpcShape("envelope");
      return body.result;
    }, { ...this.config.retry, clock: this.clock });
  }
}

/** Live or paused: the markets discovery shows. */
function listable(data: Uint8Array, nowMs: number): boolean {
  try {
    const status = pantaEventStatus(decodePantaEvent(data), nowMs);
    return status === "OPEN" || status === "PAUSED";
  } catch { return false; }
}

const notSol = () => new VenueError("VENUE_NOT_FOUND", "Not a SOL-quoted Panta market", { venue: "panta" });
const rpcShape = (what: string) => new VenueError("VENUE_SCHEMA", `Solana RPC: unexpected ${what}`, { venue: "panta" });
