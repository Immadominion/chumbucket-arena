/**
 * Add funds via Crossmint onramp — every money-relevant invariant, offline.
 *
 * Fakes only: a fake Crossmint transport (or a fake fetch for the HTTP
 * transport), a fake GoTrue verifier and identity store, a fake JSON-RPC.
 * Every key, token, address and order below is SYNTHETIC.
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { utils } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.ts";
import { loadConfig, type AppConfig } from "../src/config.ts";
import { depositsRouter } from "../src/api/deposits.ts";
import { appRouter } from "../src/api/router.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import {
  CachedDepositAccounts,
  GoTrueAccountEmailReader,
  SessionDepositAccounts,
  SupabaseLinkedWalletReader,
  type DepositPerson,
  type LinkedWalletReader,
} from "../src/deposits/accounts.ts";
import { MainnetBalanceReader, type WalletBalanceReader } from "../src/deposits/balance.ts";
import { centsToUsd, resolveDeposits, usdToCents, type DepositsConfig } from "../src/deposits/config.ts";
import {
  HttpCrossmintTransport,
  type CrossmintCreateOrderBody,
  type CrossmintOrder,
  type CrossmintTransport,
} from "../src/deposits/crossmint.ts";
import { CrossmintHttpError, DepositError } from "../src/deposits/errors.ts";
import { deriveDepositState, toDepositOrderView } from "../src/deposits/orders.ts";
import { primeDepositsRuntime, type DepositsRuntime } from "../src/deposits/runtime.ts";
import { DepositRateLimiter, DepositService, chooseDepositWallet, maskEmail, readDepositBalance } from "../src/deposits/service.ts";
import { MAINNET_GENESIS_HASH, MAINNET_USDC_MINT } from "../src/prediction/PantaChain.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";

const bs58 = utils.bytes.bs58;

// ── synthetic fixtures ────────────────────────────────────────────────────────

const SERVER_KEY = "sk_staging_SYNTHETIC_server_key_never_real";
const CLIENT_KEY = "ck_staging_SYNTHETIC_client_key_never_real";
const USER = "10000000-0000-4000-8000-0000000000d1";
const OTHER_USER = "10000000-0000-4000-8000-0000000000d2";
const AUTH_USER = "20000000-0000-4000-8000-0000000000a1";
const ORDER_ID = "9c82ef99-617f-497d-9abb-fd355291681b";

function ed25519Wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, address: bs58.encode(new Uint8Array(der.subarray(der.length - 32))) };
}
const mine = ed25519Wallet();
const second = ed25519Wallet();
const stranger = ed25519Wallet();

const stagingEnv = {
  DEPOSITS_ENABLED: "true",
  CROSSMINT_ENV: "staging",
  CROSSMINT_SERVER_API_KEY: SERVER_KEY,
  CROSSMINT_CLIENT_API_KEY: CLIENT_KEY,
};

function baseConfig(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({
    SUPABASE_URL: "https://synthetic.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role",
    SOLANA_NETWORK: "mainnet-beta",
    ...extra,
  });
}

function stagingDepositsConfig(): DepositsConfig {
  const readiness = resolveDeposits(baseConfig(), stagingEnv);
  if (!readiness.config) throw new Error("fixture config must be available");
  return readiness.config;
}

function person(overrides: Partial<DepositPerson> = {}): DepositPerson {
  return {
    userId: USER,
    authUserId: AUTH_USER,
    wallets: [
      { address: mine.address, walletType: "web3", primary: false, session: true },
      { address: second.address, walletType: "embedded", primary: true, session: false },
    ],
    email: "ada@example.com",
    ...overrides,
  };
}

function order(partial: Partial<CrossmintOrder> & { recipient?: string; delivery?: string; payment?: CrossmintOrder["payment"] } = {}): CrossmintOrder {
  const { recipient = mine.address, delivery = "awaiting-payment", ...rest } = partial;
  return {
    orderId: ORDER_ID,
    phase: "payment",
    quote: { status: "valid", expiresAt: "2026-10-02T13:25:01.803Z", totalPrice: { amount: "25", currency: "usd" } },
    lineItems: [
      {
        chain: "solana",
        quote: { quantityRange: { lowerBound: "24.100000", upperBound: "24.400000" }, totalPrice: { amount: "25", currency: "usd" } },
        delivery: { status: delivery, recipient: { locator: `solana:${recipient}`, walletAddress: recipient } },
      },
    ],
    payment: { status: "awaiting-payment", method: "card", currency: "usd" },
    ...rest,
  };
}

class FakeCrossmint implements CrossmintTransport {
  calls: Array<{ op: string; arg: unknown }> = [];
  orders = new Map<string, CrossmintOrder>();
  failCreate: unknown = null;
  failLink: unknown = null;
  nextOrderId = ORDER_ID;

  async linkWallet(input: { userLocator: string; address: string; chain: "solana"; proof?: string }) {
    this.calls.push({ op: "link", arg: input });
    if (this.failLink) throw this.failLink;
    return { address: input.address, chain: "solana", ownership: { verified: Boolean(input.proof) } };
  }
  async createOrder(body: CrossmintCreateOrderBody) {
    this.calls.push({ op: body.state === "draft" ? "draft" : "create", arg: body });
    if (this.failCreate) throw this.failCreate;
    const created = order({ orderId: this.nextOrderId, recipient: body.recipient.walletAddress });
    if (body.state !== "draft") this.orders.set(this.nextOrderId, created);
    return { clientSecret: body.state === "draft" ? null : "synthetic-client-secret", order: created };
  }
  async getOrder(orderId: string) {
    this.calls.push({ op: "get", arg: orderId });
    const found = this.orders.get(orderId);
    if (!found) throw new CrossmintHttpError(404, null, null);
    return found;
  }
  count(op: string) {
    return this.calls.filter((c) => c.op === op).length;
  }
}

function service(crossmint = new FakeCrossmint(), now = () => Date.parse("2026-10-02T12:00:00Z")) {
  return { crossmint, svc: new DepositService({ config: stagingDepositsConfig(), crossmint, now, orderCacheMs: 0 }) };
}

const expectDepositError = async (p: Promise<unknown>, code: string) => {
  try {
    await p;
  } catch (error) {
    expect(error).toBeInstanceOf(DepositError);
    expect((error as DepositError).code).toBe(code as DepositError["code"]);
    return error as DepositError;
  }
  throw new Error(`expected DepositError ${code}`);
};

// ── configuration ─────────────────────────────────────────────────────────────

describe("configuration is honest about what is missing", () => {
  test("amounts are cents, never floats", () => {
    expect(usdToCents("25")).toBe(2500);
    expect(usdToCents("25.5")).toBe(2550);
    expect(usdToCents("0.50")).toBe(50);
    expect(usdToCents("25.555")).toBeNull();
    expect(usdToCents("-1")).toBeNull();
    expect(usdToCents("1e3")).toBeNull();
    expect(usdToCents("01")).toBeNull();
    expect(centsToUsd(2550)).toBe("25.50");
    expect(centsToUsd(2500)).toBe("25");
    expect(centsToUsd(5)).toBe("0.05");
  });

  test("each missing piece reports unavailable with a plain reason", () => {
    const cfg = baseConfig();
    expect(resolveDeposits(cfg, {}).reason?.code).toBe("PAUSED");
    expect(resolveDeposits(cfg, { ...stagingEnv, DEPOSITS_ENABLED: "TRUE" }).reason?.code).toBe("PAUSED");
    expect(resolveDeposits(cfg, { ...stagingEnv, CROSSMINT_SERVER_API_KEY: undefined }).reason?.code).toBe("NOT_CONFIGURED");
    expect(resolveDeposits(cfg, { ...stagingEnv, CROSSMINT_ENV: "prod" }).reason?.code).toBe("MISCONFIGURED");
    // A staging key is never sent to the production host, nor the reverse.
    expect(resolveDeposits(cfg, { ...stagingEnv, CROSSMINT_ENV: "production" }).reason?.code).toBe("MISCONFIGURED");
    expect(resolveDeposits(cfg, { ...stagingEnv, CROSSMINT_CLIENT_API_KEY: "ck_production_x" }).reason?.code).toBe("MISCONFIGURED");
    const noAccounts = loadConfig({ SOLANA_NETWORK: "mainnet-beta" });
    expect(resolveDeposits(noAccounts, stagingEnv).reason?.code).toBe("NO_ACCOUNTS");
    for (const r of [resolveDeposits(cfg, {}), resolveDeposits(cfg, { ...stagingEnv, CROSSMINT_ENV: "production" })]) {
      expect(r.available).toBe(false);
      expect(r.config).toBeNull();
      expect(JSON.stringify(r)).not.toContain("sk_");
    }
  });

  test("staging delivers devnet test USDC and is capped at Crossmint's $10", () => {
    const r = resolveDeposits(baseConfig(), { ...stagingEnv, CROSSMINT_MAX_ORDER_USD: "500" });
    expect(r.available).toBe(true);
    expect(r.config?.apiBase).toBe("https://staging.crossmint.com/api");
    expect(r.config?.tokenLocator).toBe("solana:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    expect(r.config?.deliveryNetwork).toBe("solana-devnet");
    expect(r.config?.maxOrderCents).toBe(1000);
    expect(r.config?.presetsCents).toEqual([100, 500, 1000]);
  });

  test("production delivers mainnet USDC and stays below the $1,000 proof threshold", () => {
    const r = resolveDeposits(baseConfig(), {
      DEPOSITS_ENABLED: "true",
      CROSSMINT_ENV: "production",
      CROSSMINT_SERVER_API_KEY: "sk_production_SYNTHETIC",
      CROSSMINT_CLIENT_API_KEY: "ck_production_SYNTHETIC",
      CROSSMINT_MAX_ORDER_USD: "5000",
      CROSSMINT_MIN_ORDER_USD: "0.10",
    });
    expect(r.config?.apiBase).toBe("https://www.crossmint.com/api");
    expect(r.config?.tokenLocator).toBe(`solana:${MAINNET_USDC_MINT}`);
    expect(r.config?.deliveryNetwork).toBe("solana-mainnet");
    expect(r.config?.maxOrderCents).toBe(99_900);
    expect(r.config?.minOrderCents).toBe(50); // Crossmint's card minimum
    expect(r.config?.presetsCents).toEqual([1_000, 2_500, 5_000, 10_000]);
  });
});

// ── the recipient is never the client's to choose ─────────────────────────────

describe("recipient wallet", () => {
  test("defaults to the session wallet, then primary; a hint only selects", () => {
    expect(chooseDepositWallet(person()).address).toBe(mine.address);
    expect(chooseDepositWallet(person({ wallets: person().wallets.slice(1) })).address).toBe(second.address);
    expect(chooseDepositWallet(person(), second.address).address).toBe(second.address);
    expect(() => chooseDepositWallet(person(), stranger.address)).toThrow(DepositError);
    expect(() => chooseDepositWallet(person({ wallets: [] }))).toThrow("Connect a wallet");
  });

  test("create links and pays ONLY a server-verified wallet", async () => {
    const { crossmint, svc } = service();
    await expectDepositError(
      svc.create(person(), { amountUsd: "5", wallet: stranger.address, idempotencyKey: "key-key-key-key-0001" }),
      "WALLET_NOT_YOURS",
    );
    expect(crossmint.calls).toHaveLength(0);

    const created = await svc.create(person(), { amountUsd: "5", idempotencyKey: "key-key-key-key-0002" });
    const link = crossmint.calls[0]!;
    expect(link.op).toBe("link");
    expect(link.arg).toEqual({ userLocator: `userId:chumbucket-${USER}`, address: mine.address, chain: "solana" });
    const body = crossmint.calls[1]!.arg as CrossmintCreateOrderBody;
    expect(body).toEqual({
      recipient: { walletAddress: mine.address },
      payment: { method: "card", currency: "usd", receiptEmail: "ada@example.com" },
      lineItems: [
        { tokenLocator: "solana:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", executionParameters: { mode: "exact-in", amount: "5" } },
      ],
    });
    expect(created.order.recipient).toBe(mine.address);
    expect(created.order.state).toBe("awaiting_payment");
  });

  test("the checkout URL is Crossmint's embedded checkout with the CLIENT key, never the server key", async () => {
    const { svc } = service();
    const { checkoutUrl } = await svc.create(person(), { amountUsd: "10", idempotencyKey: "key-key-key-key-0003" });
    const url = new URL(checkoutUrl);
    expect(url.origin).toBe("https://staging.crossmint.com");
    expect(url.pathname).toBe("/sdk/2024-03-05/embedded-checkout");
    expect(url.searchParams.get("orderId")).toBe(ORDER_ID);
    expect(url.searchParams.get("clientSecret")).toBe("synthetic-client-secret");
    expect(url.searchParams.get("apiKey")).toBe(CLIENT_KEY);
    expect(checkoutUrl).not.toContain(SERVER_KEY);
    const payment = JSON.parse(url.searchParams.get("payment")!);
    expect(payment.crypto.enabled).toBe(false);
    expect(payment.fiat.allowedMethods).toEqual({ card: true, applePay: true, googlePay: true });
    const appearance = JSON.parse(url.searchParams.get("appearance")!);
    expect(appearance.rules.DestinationInput.display).toBe("hidden");
    expect(appearance.rules.GlobalMessage.display).toBe("visible");
  });

  test("a provider that echoes a different recipient is refused", async () => {
    const crossmint = new FakeCrossmint();
    crossmint.createOrder = async (body) => {
      crossmint.calls.push({ op: "create", arg: body });
      return { clientSecret: "s", order: order({ recipient: stranger.address }) };
    };
    const { svc } = service(crossmint);
    await expectDepositError(svc.create(person(), { amountUsd: "5", idempotencyKey: "key-key-key-key-0004" }), "PROVIDER_REJECTED");
  });
});

// ── amounts, email, idempotency, limits ───────────────────────────────────────

describe("order creation rules", () => {
  test("amounts outside the configured range never reach Crossmint", async () => {
    const { crossmint, svc } = service();
    await expectDepositError(svc.create(person(), { amountUsd: "0.5", idempotencyKey: "key-key-key-key-0010" }), "AMOUNT_OUT_OF_RANGE");
    await expectDepositError(svc.create(person(), { amountUsd: "10.01", idempotencyKey: "key-key-key-key-0011" }), "AMOUNT_OUT_OF_RANGE");
    await expectDepositError(svc.quote(person(), { amountUsd: "abc" }), "AMOUNT_OUT_OF_RANGE");
    expect(crossmint.calls).toHaveLength(0);
  });

  test("the account's confirmed email wins; otherwise one must be supplied", async () => {
    const { crossmint, svc } = service();
    await svc.create(person(), { amountUsd: "5", receiptEmail: "other@example.com", idempotencyKey: "key-key-key-key-0020" });
    expect((crossmint.calls[1]!.arg as CrossmintCreateOrderBody).payment.receiptEmail).toBe("ada@example.com");

    const noEmail = person({ email: null });
    await expectDepositError(svc.create(noEmail, { amountUsd: "5", idempotencyKey: "key-key-key-key-0021" }), "EMAIL_REQUIRED");
    crossmint.nextOrderId = "9c82ef99-617f-497d-9abb-fd3552916800";
    await svc.create(noEmail, { amountUsd: "5", receiptEmail: " typed@example.com ", idempotencyKey: "key-key-key-key-0022" });
    expect((crossmint.calls.at(-1)!.arg as CrossmintCreateOrderBody).payment.receiptEmail).toBe("typed@example.com");
  });

  test("a retried tap returns the same order; a changed amount under the same key is refused", async () => {
    const { crossmint, svc } = service();
    const input = { amountUsd: "5", idempotencyKey: "key-key-key-key-0030" };
    const [a, b] = await Promise.all([svc.create(person(), input), svc.create(person(), input)]);
    expect(a.order.orderId).toBe(b.order.orderId);
    expect(crossmint.count("create")).toBe(1);
    await expectDepositError(svc.create(person(), { ...input, amountUsd: "6" }), "IDEMPOTENCY_CONFLICT");
    // Another person's identical key is a different intent.
    crossmint.nextOrderId = "9c82ef99-617f-497d-9abb-fd3552916801";
    await svc.create(person({ userId: OTHER_USER }), input);
    expect(crossmint.count("create")).toBe(2);
  });

  test("a failed attempt releases its key so the person can retry", async () => {
    const { crossmint, svc } = service();
    crossmint.failCreate = new CrossmintHttpError(503, null, null);
    const input = { amountUsd: "5", idempotencyKey: "key-key-key-key-0040" };
    const failure = await expectDepositError(svc.create(person(), input), "PROVIDER_UNAVAILABLE");
    expect(failure.message).toContain("Nothing was charged");
    crossmint.failCreate = null;
    expect((await svc.create(person(), input)).order.orderId).toBe(ORDER_ID);
  });

  test("Crossmint's daily limit becomes our own copy with its numbers", async () => {
    const { crossmint, svc } = service();
    crossmint.failCreate = new CrossmintHttpError(400, "daily_transaction_exceeded", { hoursUntilReset: 5, remainingUsd: "12.50" });
    const error = await expectDepositError(svc.create(person(), { amountUsd: "10", idempotencyKey: "key-key-key-key-0050" }), "LIMIT_REACHED");
    expect(error.message).toBe("You've reached today's card limit. You can still add up to $12.50 today. It resets in about 5 hours.");
  });

  test("a wallet linked elsewhere at Crossmint is a support case, not a retry", async () => {
    const { crossmint, svc } = service();
    crossmint.failLink = new CrossmintHttpError(409, null, null);
    await expectDepositError(svc.create(person(), { amountUsd: "5", idempotencyKey: "key-key-key-key-0060" }), "WALLET_LINK_CONFLICT");
    expect(crossmint.count("create")).toBe(0);
  });

  test("the wallet is linked once per process, not on every order", async () => {
    const { crossmint, svc } = service();
    await svc.quote(person(), { amountUsd: "5" });
    await svc.create(person(), { amountUsd: "5", idempotencyKey: "key-key-key-key-0070" });
    expect(crossmint.count("link")).toBe(1);
    expect(crossmint.count("draft")).toBe(1);
  });

  test("per-person rate limits protect the shared Crossmint project budget", async () => {
    let now = 0;
    const limiter = new DepositRateLimiter(() => now);
    for (let i = 0; i < 8; i++) limiter.take(USER, "create");
    expect(() => limiter.take(USER, "create")).toThrow("a lot of tries");
    limiter.take(OTHER_USER, "create");
    now = 61_000;
    limiter.take(USER, "create");
  });
});

describe("quote", () => {
  test("is a Crossmint draft: fiat total and USDC range, nothing persisted", async () => {
    const { crossmint, svc } = service();
    const quote = await svc.quote(person(), { amountUsd: "10" });
    expect((crossmint.calls.find((c) => c.op === "draft")!.arg as CrossmintCreateOrderBody).state).toBe("draft");
    expect(crossmint.orders.size).toBe(0);
    expect(quote).toMatchObject({
      amountUsd: "10",
      totalUsd: "25",
      receiveUsdc: { min: "24.100000", max: "24.400000" },
      recipient: mine.address,
      deliveryNetwork: "solana-devnet",
    });
  });
});

// ── order status ──────────────────────────────────────────────────────────────

describe("order status", () => {
  test("someone else's order reads exactly like a missing one", async () => {
    const { crossmint, svc } = service();
    crossmint.orders.set(ORDER_ID, order({ recipient: stranger.address }));
    const error = await expectDepositError(svc.order(person(), ORDER_ID), "NOT_FOUND");
    expect(error.message).not.toContain(stranger.address);
    await expectDepositError(svc.order(person(), "9c82ef99-617f-497d-9abb-fd35529168ff"), "NOT_FOUND");
  });

  test("an order on another chain is not ours", async () => {
    const { crossmint, svc } = service();
    const evm = order();
    evm.lineItems![0]!.chain = "base-sepolia";
    crossmint.orders.set(ORDER_ID, evm);
    await expectDepositError(svc.order(person(), ORDER_ID), "NOT_FOUND");
  });

  test("delivery, not phase, decides success", async () => {
    const { crossmint, svc } = service();
    crossmint.orders.set(
      ORDER_ID,
      order({ phase: "completed", delivery: "failed", payment: { status: "completed", refunded: { amount: "10", currency: "usd" } } }),
    );
    const failed = await svc.order(person(), ORDER_ID);
    expect(failed.state).toBe("delivery_failed");
    expect(failed.terminal).toBe(true);
    expect(failed.refundedUsd).toBe("10");

    const txId = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const done = order({ phase: "completed", delivery: "completed", payment: { status: "completed" } });
    done.lineItems![0]!.delivery!.txId = txId;
    crossmint.orders.set(ORDER_ID, done);
    const delivered = await svc.order(person(), ORDER_ID);
    expect(delivered).toMatchObject({ state: "delivered", terminal: true, txId, recipient: mine.address });
  });

  test("state derivation covers every documented status", () => {
    const at = (payment: string | undefined, delivery = "awaiting-payment", extra: Partial<CrossmintOrder> = {}) =>
      deriveDepositState(order({ delivery, payment: payment ? { status: payment } : {}, ...extra }));
    expect(at("requires-recipient-verification")).toBe("awaiting_wallet_proof");
    expect(at("requires-kyc")).toBe("verifying_identity");
    expect(at("manual-kyc")).toBe("identity_review");
    expect(at("pending-kyc-review")).toBe("identity_review");
    expect(at("failed-kyc")).toBe("identity_failed");
    expect(at("awaiting-payment")).toBe("awaiting_payment");
    expect(at("requires-email")).toBe("awaiting_payment");
    expect(at("in-progress")).toBe("payment_processing");
    expect(at("completed", "in-progress")).toBe("delivering");
    expect(at("failed")).toBe("payment_failed");
    expect(at("completed", "completed")).toBe("delivered");
    expect(at("completed", "failed")).toBe("delivery_failed");
    expect(at("awaiting-payment", "awaiting-payment", { quote: { status: "expired" } })).toBe("expired");
  });

  test("provider text is made inert and bounded before it is shown", () => {
    const view = toDepositOrderView(
      order({ payment: { status: "failed", failureReason: { code: "payment-declined", message: `Declined\u0000\n${"x".repeat(500)}` } } }),
      mine.address,
      "solana-devnet",
    );
    expect(view.state).toBe("payment_failed");
    expect(view.failure?.code).toBe("payment-declined");
    expect(view.failure?.message?.startsWith("Declined x")).toBe(true);
    expect(view.failure!.message!.length).toBeLessThanOrEqual(240);
  });
});

// ── wallet ownership proof ────────────────────────────────────────────────────

describe("wallet ownership proof", () => {
  const challenge = `crossmint.com wants you to sign in with your blockchain account:\n${mine.address}\n\nI am signing this message to prove ownership.\nNonce: 123`;
  const awaitingProof = () => order({ payment: { status: "requires-recipient-verification", preparation: { message: challenge } } });

  test("the exact message is surfaced for the wallet to sign", async () => {
    const { crossmint, svc } = service();
    crossmint.orders.set(ORDER_ID, awaitingProof());
    const view = await svc.order(person(), ORDER_ID);
    expect(view.state).toBe("awaiting_wallet_proof");
    expect(view.walletProofMessage).toBe(challenge);
  });

  test("a valid signature by the recipient is verified locally, then forwarded", async () => {
    const { crossmint, svc } = service();
    crossmint.orders.set(ORDER_ID, awaitingProof());
    const signature = nodeSign(null, Buffer.from(challenge), mine.privateKey).toString("base64");
    crossmint.linkWallet = async (input) => {
      crossmint.calls.push({ op: "link", arg: input });
      crossmint.orders.set(ORDER_ID, order({ payment: { status: "awaiting-payment" } }));
      return { address: mine.address, chain: "solana", ownership: { verified: true } };
    };
    const view = await svc.verifyWallet(person(), ORDER_ID, signature);
    expect(crossmint.calls.find((c) => c.op === "link")?.arg).toEqual({
      userLocator: `userId:chumbucket-${USER}`,
      address: mine.address,
      chain: "solana",
      proof: signature,
    });
    expect(view.state).toBe("awaiting_payment");
  });

  test("a signature from another key, or over other bytes, never reaches Crossmint", async () => {
    const { crossmint, svc } = service();
    crossmint.orders.set(ORDER_ID, awaitingProof());
    const foreign = nodeSign(null, Buffer.from(challenge), stranger.privateKey).toString("base64");
    await expectDepositError(svc.verifyWallet(person(), ORDER_ID, foreign), "BAD_PROOF");
    const otherBytes = nodeSign(null, Buffer.from(`${challenge}!`), mine.privateKey).toString("base64");
    await expectDepositError(svc.verifyWallet(person(), ORDER_ID, otherBytes), "BAD_PROOF");
    await expectDepositError(svc.verifyWallet(person(), ORDER_ID, "AAAA"), "BAD_PROOF");
    expect(crossmint.count("link")).toBe(0);
  });

  test("no proof is forwarded when the order isn't asking for one", async () => {
    const { crossmint, svc } = service();
    crossmint.orders.set(ORDER_ID, order());
    const signature = nodeSign(null, Buffer.from(challenge), mine.privateKey).toString("base64");
    await expectDepositError(svc.verifyWallet(person(), ORDER_ID, signature), "NOT_AWAITING_PROOF");
    expect(crossmint.count("link")).toBe(0);
  });
});

// ── HTTP transport against a fake fetch ───────────────────────────────────────

describe("HttpCrossmintTransport", () => {
  type Seen = { url: string; init: RequestInit };
  const fakeFetch = (responder: (seen: Seen) => Response) => {
    const seen: Seen[] = [];
    const impl = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const s = { url: String(url), init: init ?? {} };
        seen.push(s);
        return responder(s);
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch;
    return { seen, impl };
  };

  test("sends the documented requests with the server key only in X-API-KEY", async () => {
    const { seen, impl } = fakeFetch(({ url }) =>
      url.includes("/orders/")
        ? Response.json(order())
        : url.endsWith("/orders")
          ? Response.json({ clientSecret: "cs", order: order() }, { status: 201 })
          : Response.json({ address: mine.address, chain: "solana", ownership: { verified: false, verificationChallenge: "x" } }),
    );
    const t = new HttpCrossmintTransport("https://staging.crossmint.com/api", SERVER_KEY, impl);
    await t.linkWallet({ userLocator: `userId:chumbucket-${USER}`, address: mine.address, chain: "solana" });
    const created = await t.createOrder({
      recipient: { walletAddress: mine.address },
      payment: { method: "card", currency: "usd", receiptEmail: "ada@example.com" },
      lineItems: [{ tokenLocator: "solana:x", executionParameters: { mode: "exact-in", amount: "5" } }],
    });
    await t.getOrder(ORDER_ID);

    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      `PUT https://staging.crossmint.com/api/2025-06-09/users/userId:chumbucket-${USER}/linked-wallets/${mine.address}`,
      "POST https://staging.crossmint.com/api/2022-06-09/orders",
      `GET https://staging.crossmint.com/api/2022-06-09/orders/${ORDER_ID}`,
    ]);
    for (const s of seen) {
      expect((s.init.headers as Record<string, string>)["X-API-KEY"]).toBe(SERVER_KEY);
      expect(s.init.redirect).toBe("error");
      expect(s.url).not.toContain(SERVER_KEY);
    }
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ chain: "solana" });
    expect(created.clientSecret).toBe("cs");
  });

  test("failures carry a status and machine code, never the body or the key", async () => {
    const cases: Array<[Response, number, string | null]> = [
      [Response.json({ error: true, message: `bad ${SERVER_KEY}`, code: "daily_transaction_exceeded", parameters: { hoursUntilReset: "3", remainingAmount: "4" } }, { status: 400 }), 400, "daily_transaction_exceeded"],
      [new Response("<html>rate limited</html>", { status: 429 }), 429, null],
      [Response.json({ message: "nope" }, { status: 403 }), 403, null],
      [new Response("", { status: 524 }), 524, null],
    ];
    for (const [response, status, code] of cases) {
      const { impl } = fakeFetch(() => response);
      const t = new HttpCrossmintTransport("https://staging.crossmint.com/api", SERVER_KEY, impl);
      try {
        await t.getOrder(ORDER_ID);
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CrossmintHttpError);
        expect((error as CrossmintHttpError).status).toBe(status);
        expect((error as CrossmintHttpError).providerCode).toBe(code);
        expect(String((error as Error).message)).not.toContain(SERVER_KEY);
      }
    }
    const { impl } = fakeFetch(() => {
      throw new Error(`socket closed for ${SERVER_KEY}`);
    });
    const t = new HttpCrossmintTransport("https://staging.crossmint.com/api", SERVER_KEY, impl);
    await expect(t.getOrder(ORDER_ID)).rejects.toMatchObject({ status: 0 });
  });

  test("refuses a non-https or credentialed base", () => {
    expect(() => new HttpCrossmintTransport("http://staging.crossmint.com/api", SERVER_KEY)).toThrow();
    expect(() => new HttpCrossmintTransport("https://u:p@staging.crossmint.com/api", SERVER_KEY)).toThrow();
  });
});

// ── accounts ──────────────────────────────────────────────────────────────────

describe("who is adding funds", () => {
  const rig = (rows: Array<{ address: string; walletType: string; primary: boolean }>) => {
    const cfg = baseConfig();
    const store = new FakeIdentityStore().addUser(AUTH_USER, USER);
    const verifier = new FakeJwtVerifier()
      .issue("session-wallet", AUTH_USER, mine.address)
      .issue("session-google", AUTH_USER)
      .issue("session-unlinked", "20000000-0000-4000-8000-0000000000ff");
    primeAuthIdentityRuntime(cfg, { store, verifier, policy: resolveAuthIdentityPolicy(cfg) });
    const reads: string[] = [];
    const wallets: LinkedWalletReader = {
      async activeVerified(userId) {
        reads.push(userId);
        return rows;
      },
    };
    const emails = { asked: 0, async confirmedEmail() { this.asked++; return "ada@example.com"; } };
    return { cfg, accounts: new SessionDepositAccounts(cfg, wallets, emails), reads, emails };
  };

  test("the session's verified wallet leads; proven linked rows follow; no token means signed out", async () => {
    const { accounts, emails } = rig([
      { address: second.address, walletType: "embedded", primary: true },
      { address: mine.address, walletType: "mwa", primary: false },
    ]);
    const r = await accounts.resolve("session-wallet", { email: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.person.wallets.map((w) => [w.address, w.session])).toEqual([
      [mine.address, true],
      [second.address, false],
    ]);
    expect(r.person.wallets[0]!.walletType).toBe("mwa");
    expect(r.person.email).toBe("ada@example.com");
    expect(emails.asked).toBe(1);

    const google = await accounts.resolve("session-google");
    expect(google.ok && google.person.wallets.map((w) => w.address)).toEqual([second.address, mine.address]);
    expect(google.ok && google.person.email).toBeNull();
    expect(emails.asked).toBe(1);

    expect(await accounts.resolve(undefined)).toEqual({ ok: false, reason: "SIGNED_OUT" });
    expect(await accounts.resolve("forged")).toEqual({ ok: false, reason: "SIGNED_OUT" });
    expect(await accounts.resolve("session-unlinked")).toEqual({ ok: false, reason: "NOT_LINKED" });
  });

  test("cached resolutions are reused briefly and never keyed by the raw token", async () => {
    const { accounts, reads } = rig([]);
    let now = 0;
    const cached = new CachedDepositAccounts(accounts, 15_000, () => now);
    await cached.resolve("session-wallet");
    await cached.resolve("session-wallet");
    expect(reads).toHaveLength(1);
    now = 16_000;
    await cached.resolve("session-wallet");
    expect(reads).toHaveLength(2);
    expect(JSON.stringify([...(cached as unknown as { hits: Map<string, unknown> }).hits.keys()])).not.toContain("session-wallet");
  });

  test("linked wallets are read active-and-proven only, with the service role", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return Response.json([
        { wallet_address: mine.address, wallet_type: "mwa", is_primary: true },
        { wallet_address: "not-an-address", wallet_type: "mwa", is_primary: false },
      ]);
    }) as unknown as typeof fetch;
    const reader = new SupabaseLinkedWalletReader({ supabaseUrl: "https://synthetic.invalid/", serviceRoleKey: "svc" }, fetchImpl);
    expect(await reader.activeVerified(USER)).toEqual([{ address: mine.address, walletType: "mwa", primary: true }]);
    const url = new URL(seen!.url);
    expect(url.pathname).toBe("/rest/v1/linked_wallets");
    expect(url.searchParams.get("user_id")).toBe(`eq.${USER}`);
    expect(url.searchParams.get("revoked_at")).toBe("is.null");
    expect(url.searchParams.get("verified_at")).toBe("not.is.null");
    expect(seen!.init?.redirect).toBe("manual");
  });

  test("only a confirmed email is used for the receipt", async () => {
    const reply = (body: unknown, status = 200) =>
      (async () => Response.json(body, { status })) as unknown as typeof fetch;
    const cfg = { supabaseUrl: "https://synthetic.invalid", serviceRoleKey: "svc" };
    expect(await new GoTrueAccountEmailReader(cfg, reply({ email: "a@b.co", email_confirmed_at: "2026-01-01" })).confirmedEmail(AUTH_USER)).toBe("a@b.co");
    expect(await new GoTrueAccountEmailReader(cfg, reply({ email: "a@b.co" })).confirmedEmail(AUTH_USER)).toBeNull();
    expect(await new GoTrueAccountEmailReader(cfg, reply({}, 500)).confirmedEmail(AUTH_USER)).toBeNull();
    expect(await new GoTrueAccountEmailReader(cfg, reply({ email: "a@b.co", email_confirmed_at: "x" })).confirmedEmail("../admin")).toBeNull();
  });

  test("email masking keeps a hint and hides the rest", () => {
    expect(maskEmail("ada.lovelace@example.com")).toBe("ad••••••@example.com");
    expect(maskEmail("a@b.co")).toBe("a•@b.co");
  });
});

// ── mainnet balance read ──────────────────────────────────────────────────────

describe("mainnet balance", () => {
  const rpc = (genesis: string, accounts: unknown[]) =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      const ctx = { context: { slot: 321, apiVersion: "2.0.0" } };
      const result =
        body.method === "getGenesisHash"
          ? genesis
          : body.method === "getBalance"
            ? { ...ctx, value: 12_345_678 }
            : { ...ctx, value: accounts };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }) as unknown as typeof fetch;
  const tokenAccount = (owner: string, amount: string, mint = MAINNET_USDC_MINT) => ({
    pubkey: Keypair.generate().publicKey.toBase58(),
    account: {
      data: { program: "spl-token", parsed: { type: "account", info: { mint, owner, tokenAmount: { amount, decimals: 6, uiAmount: 0, uiAmountString: "0" } } }, space: 165 },
      executable: false,
      lamports: 2039280,
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      rentEpoch: 0,
      space: 165,
    },
  });

  test("sums the owner's USDC accounts as integers and reports real SOL", async () => {
    const reader = new MainnetBalanceReader(
      "https://rpc.synthetic.invalid",
      rpc(MAINNET_GENESIS_HASH, [tokenAccount(mine.address, "1500000"), tokenAccount(mine.address, "250000"), tokenAccount(stranger.address, "9")]),
      () => Date.parse("2026-10-02T12:00:00Z"),
    );
    expect(await reader.read(mine.address)).toEqual({
      wallet: mine.address,
      network: "solana-mainnet",
      lamports: "12345678",
      usdcBaseUnits: "1750000",
      slot: 321,
      readAt: "2026-10-02T12:00:00.000Z",
    });
  });

  test("a devnet RPC is never reported as a mainnet balance", async () => {
    const reader = new MainnetBalanceReader("https://rpc.synthetic.invalid", rpc("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", []));
    await expect(reader.read(mine.address)).rejects.toThrow();
    const failing: WalletBalanceReader = { read: () => reader.read(mine.address) };
    await expectDepositError(readDepositBalance({ reader: failing }, person(), undefined), "BALANCE_UNAVAILABLE");
  });

  test("the balance is only ever read for one of the person's wallets", async () => {
    const read: string[] = [];
    const reader: WalletBalanceReader = {
      async read(wallet) {
        read.push(wallet);
        return { wallet, network: "solana-mainnet", lamports: "0", usdcBaseUnits: "0", slot: 1, readAt: "x" };
      },
    };
    await readDepositBalance({ reader }, person(), second.address);
    await expectDepositError(readDepositBalance({ reader }, person(), stranger.address), "WALLET_NOT_YOURS");
    expect(read).toEqual([second.address]);
  });
});

// ── the tRPC surface ──────────────────────────────────────────────────────────

describe("deposits router", () => {
  async function routerRig(env: Record<string, string | undefined>) {
    const cfg = baseConfig();
    const app = await createApp({ config: cfg });
    const crossmint = new FakeCrossmint();
    const readiness = resolveDeposits(cfg, env);
    const accounts = {
      async resolve(token: string | undefined) {
        if (token === "session-ok") return { ok: true as const, person: person() };
        return { ok: false as const, reason: "SIGNED_OUT" as const };
      },
    };
    const balances: WalletBalanceReader = {
      async read(wallet) {
        return { wallet, network: "solana-mainnet", lamports: "5000000", usdcBaseUnits: "2500000", slot: 9, readAt: "2026-10-02T12:00:00.000Z" };
      },
    };
    const limiter = new DepositRateLimiter();
    const runtime: DepositsRuntime = {
      readiness,
      service: readiness.config ? new DepositService({ config: readiness.config, crossmint, limiter, orderCacheMs: 0 }) : null,
      accounts,
      balances,
      limiter,
    };
    primeDepositsRuntime(cfg, runtime);
    return {
      crossmint,
      signedIn: depositsRouter.createCaller({ app, supabaseAccessToken: "session-ok" }),
      anonymous: depositsRouter.createCaller({ app }),
    };
  }

  test("is mounted as deposits.* and every procedure is a POST mutation", () => {
    const procedures = appRouter._def.procedures as Record<string, { _def?: { type?: string } }>;
    for (const name of ["status", "balance", "quote", "create", "order", "verifyWallet"]) {
      expect(procedures[`deposits.${name}`]?._def?.type).toBe("mutation");
    }
  });

  test("unconfigured: says so in words and creates nothing", async () => {
    const { signedIn, anonymous, crossmint } = await routerRig({});
    const status = await anonymous.status();
    expect(status).toMatchObject({ available: false, reason: { code: "PAUSED" }, account: null, accountIssue: "SIGNED_OUT", presetsUsd: [] });
    await expect(signedIn.create({ amountUsd: "5", idempotencyKey: "key-key-key-key-0100" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Adding funds is paused right now. Your wallet and balance are unaffected.",
    });
    expect(crossmint.calls).toHaveLength(0);
    // The balance does not depend on Crossmint.
    expect((await signedIn.balance({})).usdcBaseUnits).toBe("2500000");
  });

  test("signed out: no order, no balance", async () => {
    const { anonymous } = await routerRig(stagingEnv);
    await expect(anonymous.create({ amountUsd: "5", idempotencyKey: "key-key-key-key-0101" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.balance({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.order({ orderId: ORDER_ID })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("signed in: status lists only the person's wallets and a masked email", async () => {
    const { signedIn } = await routerRig(stagingEnv);
    const status = await signedIn.status();
    expect(status).toMatchObject({
      available: true,
      environment: "staging",
      deliveryNetwork: "solana-devnet",
      limits: { minUsd: "1", maxUsd: "10" },
      presetsUsd: ["1", "5", "10"],
      account: { receiptEmail: "ad•@example.com", needsEmail: false },
    });
    expect(status.account?.wallets.map((w) => w.address)).toEqual([mine.address, second.address]);
  });

  test("a recipient address cannot be smuggled in", async () => {
    const { signedIn, crossmint } = await routerRig(stagingEnv);
    await expect(
      signedIn.create({ amountUsd: "5", idempotencyKey: "key-key-key-key-0102", walletAddress: stranger.address } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      signedIn.create({ amountUsd: "5", idempotencyKey: "key-key-key-key-0103", wallet: stranger.address }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(crossmint.calls).toHaveLength(0);
  });

  test("create → order: the full happy path through the router", async () => {
    const { signedIn, crossmint } = await routerRig(stagingEnv);
    const created = await signedIn.create({ amountUsd: "5", idempotencyKey: "key-key-key-key-0104" });
    expect(created.order).toMatchObject({ orderId: ORDER_ID, state: "awaiting_payment", recipient: mine.address });
    expect(created.checkoutUrl.startsWith("https://staging.crossmint.com/sdk/2024-03-05/embedded-checkout?")).toBe(true);
    const done = order({ phase: "completed", delivery: "completed", payment: { status: "completed" } });
    crossmint.orders.set(ORDER_ID, done);
    expect((await signedIn.order({ orderId: ORDER_ID })).state).toBe("delivered");
  });

  test("an unexpected failure is generic and causeless", async () => {
    const { signedIn, crossmint } = await routerRig(stagingEnv);
    crossmint.getOrder = async () => {
      throw new TypeError(`boom ${SERVER_KEY}`);
    };
    const error = await signedIn.order({ orderId: ORDER_ID }).catch((e) => e);
    expect(error.code).toBe("BAD_GATEWAY");
    expect(String(error.message)).not.toContain(SERVER_KEY);
    expect(error.message).toContain("Nothing was charged");
  });
});
