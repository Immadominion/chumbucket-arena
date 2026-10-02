/**
 * Jupiter Swap API v2 transport — the only code that holds JUPITER_API_KEY.
 *
 *   GET  {base}/order   quote + assembled unsigned transaction (with `taker`)
 *   POST {base}/execute the person's signed transaction + requestId; Jupiter
 *                       lands it (and, when gasless, adds the fee payer's
 *                       signature).
 *
 * Reference: https://developers.jup.ag/docs/swap/order-and-execute.md and the
 * OpenAPI spec https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml
 * (read 2026-10-02). The key travels only in `x-api-key`, only to the pinned
 * host. Redirects are refused, bodies are bounded, and a failure carries a
 * status only — never Jupiter's body, which can echo request data.
 */

import { z } from "zod";

export interface JupiterOrderRequest {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker?: string;
  /** Comma-separated: metis, jupiterz, dflow, okx. */
  excludeRouters?: string;
}

const lamportString = z.string().regex(/^[0-9]{1,20}$/);
const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

const orderSchema = z.object({
  router: z.string().optional(),
  mode: z.string().optional(),
  inputMint: address,
  outputMint: address,
  inAmount: lamportString,
  outAmount: lamportString,
  otherAmountThreshold: lamportString.optional(),
  slippageBps: z.number().int().min(0).max(10_000).optional(),
  feeBps: z.number().min(0).max(10_000).optional(),
  gasless: z.boolean().optional(),
  signatureFeePayer: address.nullable().optional(),
  prioritizationFeePayer: address.nullable().optional(),
  rentFeePayer: address.nullable().optional(),
  signatureFeeLamports: z.number().nonnegative().optional(),
  prioritizationFeeLamports: z.number().nonnegative().optional(),
  rentFeeLamports: z.number().nonnegative().optional(),
  transaction: z.string().max(4_096).nullable().optional(),
  requestId: z.string().min(1).max(128).optional(),
  taker: address.nullable().optional(),
  expireAt: z.union([z.string(), z.number()]).optional(),
  errorCode: z.number().int().nullable().optional(),
  inUsdValue: z.number().optional(),
  outUsdValue: z.number().optional(),
}).passthrough();

export type JupiterOrder = z.infer<typeof orderSchema>;

const executeSchema = z.object({
  status: z.enum(["Success", "Failed"]),
  signature: z.string().max(100).optional(),
  slot: z.union([z.string(), z.number()]).optional(),
  code: z.number().int().optional(),
  totalInputAmount: lamportString.optional(),
  totalOutputAmount: lamportString.optional(),
  inputAmountResult: lamportString.optional(),
  outputAmountResult: lamportString.optional(),
}).passthrough();

export type JupiterExecuteResult = z.infer<typeof executeSchema>;

export interface JupiterTransport {
  order(request: JupiterOrderRequest): Promise<JupiterOrder>;
  execute(signedTransaction: string, requestId: string): Promise<JupiterExecuteResult>;
}

export class JupiterHttpError extends Error {
  constructor(
    readonly status: number,
    /** Jupiter's numeric `code`, when its error body had one. */
    readonly code: number | null = null,
  ) {
    super(`Jupiter HTTP ${status}`);
    this.name = "JupiterHttpError";
  }
}

const MAX_BODY_BYTES = 256 * 1024;

export class HttpJupiterTransport implements JupiterTransport {
  private queue: Promise<void> = Promise.resolve();
  private lastOrderAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly apiBase: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 12_000,
    private readonly minIntervalMs = 1_100,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    const parsed = new URL(apiBase);
    if (parsed.protocol !== "https:" || parsed.host !== "api.jup.ag" || parsed.username || parsed.password || parsed.search) {
      throw new Error("Jupiter transport needs the pinned https://api.jup.ag base");
    }
  }

  /** /order calls share one plan-wide budget (Free: 1 request/second). */
  private paced<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastOrderAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastOrderAt = this.now();
    });
    this.queue = run.catch(() => undefined);
    return run.then(work);
  }

  order(request: JupiterOrderRequest): Promise<JupiterOrder> {
    const params = new URLSearchParams({ inputMint: request.inputMint, outputMint: request.outputMint, amount: request.amount });
    if (request.taker) params.set("taker", request.taker);
    if (request.excludeRouters) params.set("excludeRouters", request.excludeRouters);
    return this.paced(async () => orderSchema.parse(await this.call("GET", `/order?${params}`)));
  }

  async execute(signedTransaction: string, requestId: string): Promise<JupiterExecuteResult> {
    return executeSchema.parse(await this.call("POST", "/execute", { signedTransaction, requestId }));
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await readBounded(res);
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const code = parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "number"
        ? (parsed as { code: number }).code
        : null;
      throw new JupiterHttpError(res.status, code);
    }
    if (parsed === null) throw new JupiterHttpError(502);
    return parsed;
  }
}

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new JupiterHttpError(502);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
