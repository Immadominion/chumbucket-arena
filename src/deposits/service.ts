/**
 * Add funds: Crossmint onramp orders that deliver USDC on Solana to the
 * signed-in person's OWN wallet.
 *
 * Invariants this file keeps:
 *   1. The recipient is resolved here, from the person's server-verified
 *      wallets. A client can only pick among them; any other address is refused.
 *   2. An order is shown to a person only when it has a single Solana line
 *      item whose delivery recipient is one of their wallets. Crossmint's order
 *      object doesn't name the token, so the token isn't re-checked here: the
 *      server key already scopes reads to our project, which only ever creates
 *      orders for the configured USDC locator.
 *   3. Nothing is simulated. No key, no switch, no account database → the
 *      caller hears "unavailable", in words, and nothing is created.
 *   4. Crossmint's body text never becomes our error message.
 */

import { createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { DepositPerson, DepositWallet } from "./accounts.ts";
import type { WalletBalance, WalletBalanceReader } from "./balance.ts";
import { centsToUsd, usdToCents, type DepositsConfig } from "./config.ts";
import type { CrossmintCreateOrderBody, CrossmintOrder, CrossmintTransport } from "./crossmint.ts";
import { DepositError, depositErrorFromProvider } from "./errors.ts";
import { toDepositOrderView, type DepositOrderView } from "./orders.ts";

export interface DepositQuote {
  amountUsd: string;
  currency: "usd";
  /** Charged to the card, all fees included, as Crossmint quoted it. */
  totalUsd: string | null;
  receiveUsdc: { min: string; max: string } | null;
  networkFeeUsd: string | null;
  expiresAt: string | null;
  recipient: string;
  deliveryNetwork: DepositsConfig["deliveryNetwork"];
}

export interface CreatedDeposit {
  order: DepositOrderView;
  /** Crossmint's embedded checkout for this one order. Device-only. */
  checkoutUrl: string;
}

export interface DepositAmountInput {
  amountUsd: string;
  wallet?: string | undefined;
  receiptEmail?: string | undefined;
}

type Action = "quote" | "create" | "order" | "proof" | "balance";
const LIMITS: Record<Action, number> = { quote: 30, create: 8, order: 90, proof: 6, balance: 40 };

/** Per-person sliding window. Crossmint allows 120 writes/min per PROJECT. */
export class DepositRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}
  take(userId: string, action: Action): void {
    const key = `${userId}:${action}`;
    const cutoff = this.now() - 60_000;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= LIMITS[action]) {
      throw new DepositError("RATE_LIMITED", "That's a lot of tries in a minute. Give it a moment and try again.");
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
  }
}

export interface DepositServiceDeps {
  config: DepositsConfig;
  crossmint: CrossmintTransport;
  now?: () => number;
  limiter?: DepositRateLimiter;
  /** How long a polled order read is reused. Crossmint allows 360 GET/min/project. */
  orderCacheMs?: number;
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/** The person's wallet to fund. `hint` may only select, never introduce. */
export function chooseDepositWallet(person: DepositPerson, hint?: string): DepositWallet {
  if (hint !== undefined) {
    const named = person.wallets.find((w) => w.address === hint);
    if (!named) {
      throw new DepositError("WALLET_NOT_YOURS", "That wallet isn't connected to your account. Reconnect it in Settings, then try again.");
    }
    return named;
  }
  const chosen = person.wallets.find((w) => w.session) ?? person.wallets.find((w) => w.primary) ?? person.wallets[0];
  if (!chosen) {
    throw new DepositError("NO_WALLET", "Connect a wallet to your account first. Funds can only go to a wallet you've proven is yours.");
  }
  return chosen;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${"•".repeat(Math.max(1, Math.min(local.length - head.length, 6)))}@${domain}`;
}

export class DepositService {
  private readonly now: () => number;
  private readonly limiter: DepositRateLimiter;
  private readonly orderCacheMs: number;
  private readonly linked = new Set<string>();
  private readonly orderCache = new Map<string, { at: number; order: CrossmintOrder }>();
  private readonly created = new Map<string, { at: number; amountCents: number; wallet: string; result: Promise<CreatedDeposit> }>();

  constructor(private readonly deps: DepositServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.limiter = deps.limiter ?? new DepositRateLimiter(this.now);
    this.orderCacheMs = deps.orderCacheMs ?? 2_000;
  }

  get config(): DepositsConfig {
    return this.deps.config;
  }

  async quote(person: DepositPerson, input: DepositAmountInput): Promise<DepositQuote> {
    this.limiter.take(person.userId, "quote");
    const amountCents = this.amount(input.amountUsd);
    const wallet = chooseDepositWallet(person, input.wallet);
    const email = this.receiptEmail(person, input.receiptEmail);
    await this.ensureLinked(person.userId, wallet.address);
    let order: CrossmintOrder;
    try {
      ({ order } = await this.deps.crossmint.createOrder({ ...this.orderBody(wallet.address, email, amountCents), state: "draft" }));
    } catch (error) {
      throw depositErrorFromProvider(error);
    }
    const item = order.lineItems?.[0];
    const range = item?.quote?.quantityRange;
    const lower = typeof range?.lowerBound === "string" ? range.lowerBound : null;
    const upper = typeof range?.upperBound === "string" ? range.upperBound : lower;
    const networkFee = item?.quote?.charges?.networkFee?.amount;
    const view = toDepositOrderView(order, wallet.address, this.deps.config.deliveryNetwork);
    return {
      amountUsd: centsToUsd(amountCents),
      currency: "usd",
      totalUsd: view.totalUsd,
      receiveUsdc: lower && upper && /^[0-9.]+$/.test(lower) && /^[0-9.]+$/.test(upper) ? { min: lower, max: upper } : null,
      networkFeeUsd: typeof networkFee === "string" && /^[0-9]+(\.[0-9]+)?$/.test(networkFee) ? networkFee : null,
      expiresAt: view.quoteExpiresAt,
      recipient: wallet.address,
      deliveryNetwork: this.deps.config.deliveryNetwork,
    };
  }

  /** Idempotent per (person, key): a retried tap returns the same order. */
  async create(person: DepositPerson, input: DepositAmountInput & { idempotencyKey: string }): Promise<CreatedDeposit> {
    const amountCents = this.amount(input.amountUsd);
    const wallet = chooseDepositWallet(person, input.wallet);
    const key = `${person.userId}:${input.idempotencyKey}`;
    this.prune();
    const prior = this.created.get(key);
    if (prior) {
      if (prior.amountCents !== amountCents || prior.wallet !== wallet.address) {
        throw new DepositError("IDEMPOTENCY_CONFLICT", "This payment was already started with different details. Start a new one.");
      }
      return prior.result;
    }
    this.limiter.take(person.userId, "create");
    const email = this.receiptEmail(person, input.receiptEmail);
    const result = (async () => {
      await this.ensureLinked(person.userId, wallet.address);
      let created: { clientSecret: string | null; order: CrossmintOrder };
      try {
        created = await this.deps.crossmint.createOrder(this.orderBody(wallet.address, email, amountCents));
      } catch (error) {
        throw depositErrorFromProvider(error);
      }
      const orderId = created.order.orderId;
      if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId) || !created.clientSecret) {
        throw new DepositError("PROVIDER_UNAVAILABLE", "Our payment partner didn't confirm the payment. Nothing was charged. Try again.");
      }
      // The create response names the recipient we sent; anything else is a
      // provider fault we refuse to hand to the device.
      const echoed = created.order.lineItems?.[0]?.delivery?.recipient?.walletAddress;
      if (echoed !== undefined && echoed !== wallet.address) {
        throw new DepositError("PROVIDER_REJECTED", "Our payment partner returned a different wallet. Nothing was charged.");
      }
      return {
        order: toDepositOrderView(created.order, wallet.address, this.deps.config.deliveryNetwork),
        checkoutUrl: this.checkoutUrl(orderId, created.clientSecret),
      };
    })();
    this.created.set(key, { at: this.now(), amountCents, wallet: wallet.address, result });
    // A failed attempt must not pin the key: the person can retry it.
    result.catch(() => this.created.delete(key));
    return result;
  }

  async order(person: DepositPerson, orderId: string): Promise<DepositOrderView> {
    this.limiter.take(person.userId, "order");
    const order = await this.readOrder(orderId);
    const recipient = this.assertOwnOrder(person, order);
    return toDepositOrderView(order, recipient, this.deps.config.deliveryNetwork);
  }

  /**
   * Crossmint asks external-wallet recipients to sign a message once volume
   * passes its threshold. We check the signature ourselves before forwarding
   * it, so a bad or foreign signature never reaches the provider.
   */
  async verifyWallet(person: DepositPerson, orderId: string, signatureBase64: string): Promise<DepositOrderView> {
    this.limiter.take(person.userId, "proof");
    this.orderCache.delete(orderId);
    const order = await this.readOrder(orderId);
    const recipient = this.assertOwnOrder(person, order);
    const message = order.payment?.preparation?.message;
    if (order.payment?.status !== "requires-recipient-verification" || typeof message !== "string" || !message) {
      throw new DepositError("NOT_AWAITING_PROOF", "This payment doesn't need a wallet signature right now.");
    }
    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== signatureBase64) {
      throw new DepositError("BAD_PROOF", "That signature didn't come from your wallet. Nothing was sent.");
    }
    let valid = false;
    try {
      const key = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([SPKI_ED25519, new PublicKey(recipient).toBuffer()]) });
      valid = verify(null, Buffer.from(message, "utf8"), key, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new DepositError("BAD_PROOF", "That signature didn't come from your wallet. Nothing was sent.");
    try {
      await this.deps.crossmint.linkWallet({ userLocator: this.userLocator(person.userId), address: recipient, chain: "solana", proof: signatureBase64 });
    } catch (error) {
      throw depositErrorFromProvider(error);
    }
    this.orderCache.delete(orderId);
    return toDepositOrderView(await this.readOrder(orderId), recipient, this.deps.config.deliveryNetwork);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private amount(amountUsd: string): number {
    const cents = usdToCents(amountUsd);
    const { minOrderCents, maxOrderCents } = this.deps.config;
    if (cents === null || cents < minOrderCents || cents > maxOrderCents) {
      throw new DepositError(
        "AMOUNT_OUT_OF_RANGE",
        `Choose an amount from $${centsToUsd(minOrderCents)} to $${centsToUsd(maxOrderCents)}.`,
      );
    }
    return cents;
  }

  private receiptEmail(person: DepositPerson, supplied: string | undefined): string {
    if (person.email) return person.email;
    const email = supplied?.trim();
    if (email && EMAIL.test(email)) return email;
    throw new DepositError("EMAIL_REQUIRED", "Add an email for your receipt. Our payment partner requires one.");
  }

  private userLocator(userId: string): string {
    return `userId:chumbucket-${userId}`;
  }

  private async ensureLinked(userId: string, address: string): Promise<void> {
    const key = `${userId}:${address}`;
    if (this.linked.has(key)) return;
    try {
      await this.deps.crossmint.linkWallet({ userLocator: this.userLocator(userId), address, chain: "solana" });
    } catch (error) {
      throw depositErrorFromProvider(error);
    }
    this.linked.add(key);
  }

  private orderBody(wallet: string, receiptEmail: string, amountCents: number): CrossmintCreateOrderBody {
    return {
      recipient: { walletAddress: wallet },
      payment: { method: "card", currency: "usd", receiptEmail },
      lineItems: [{ tokenLocator: this.deps.config.tokenLocator, executionParameters: { mode: "exact-in", amount: centsToUsd(amountCents) } }],
    };
  }

  private async readOrder(orderId: string): Promise<CrossmintOrder> {
    const cached = this.orderCache.get(orderId);
    if (cached && this.now() - cached.at < this.orderCacheMs) return cached.order;
    let order: CrossmintOrder;
    try {
      order = await this.deps.crossmint.getOrder(orderId);
    } catch (error) {
      throw depositErrorFromProvider(error);
    }
    this.orderCache.set(orderId, { at: this.now(), order });
    if (this.orderCache.size > 5_000) this.orderCache.delete(this.orderCache.keys().next().value as string);
    return order;
  }

  /**
   * Not delivering to one of your wallets, or not a single Solana line item →
   * indistinguishable from "not found". Orders are already scoped to our
   * Crossmint project by the server key; this scopes them to the person.
   */
  private assertOwnOrder(person: DepositPerson, order: CrossmintOrder): string {
    const item = order.lineItems?.[0];
    const recipient = item?.delivery?.recipient?.walletAddress;
    const locator = item?.delivery?.recipient?.locator;
    const chain = this.deps.config.chain;
    const chainOk = (item?.chain ?? chain).startsWith(chain) && (!locator || locator.startsWith(chain));
    const mine = typeof recipient === "string" && person.wallets.some((w) => w.address === recipient);
    if (!mine || order.lineItems?.length !== 1 || !chainOk) {
      throw new DepositError("NOT_FOUND", "We couldn't find that payment on your account.");
    }
    return recipient;
  }

  private checkoutUrl(orderId: string, clientSecret: string): string {
    const payment = {
      crypto: { enabled: false },
      fiat: { enabled: true, allowedMethods: { card: true, applePay: true, googlePay: true } },
      defaultMethod: "fiat",
    };
    const appearance = {
      fonts: [{ cssSrc: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" }],
      variables: {
        fontFamily: "Inter, system-ui, sans-serif",
        borderRadius: "14px",
        colors: {
          accent: "#FF3355",
          backgroundPrimary: "#FFFFFF",
          borderPrimary: "#E5E7EB",
          textPrimary: "#111827",
          textSecondary: "#6B7280",
          danger: "#EF4444",
          warning: "#F59E0B",
        },
      },
      rules: {
        DestinationInput: { display: "hidden" },
        ReceiptEmailInput: { display: "hidden" },
        GlobalMessage: { display: "visible" },
        PrimaryButton: {
          borderRadius: "22px",
          font: { family: "Inter", size: "16px", weight: "600" },
          colors: { text: "#FFFFFF", background: "#FF3355" },
          hover: { colors: { background: "#FF5A76" } },
          disabled: { colors: { text: "#FFFFFF", background: "#FFB3C0" } },
        },
      },
    };
    const params = new URLSearchParams({
      orderId,
      clientSecret,
      apiKey: this.deps.config.clientApiKey,
      payment: JSON.stringify(payment),
      appearance: JSON.stringify(appearance),
    });
    return `${this.deps.config.checkoutBase}/sdk/2024-03-05/embedded-checkout?${params.toString()}`;
  }

  private prune(): void {
    const cutoff = this.now() - 30 * 60_000;
    for (const [key, entry] of this.created) if (entry.at < cutoff) this.created.delete(key);
  }
}

export interface BalanceServiceDeps {
  reader: WalletBalanceReader;
  limiter?: DepositRateLimiter;
}

/** Independent of Crossmint: the trade review needs a balance either way. */
export async function readDepositBalance(
  deps: BalanceServiceDeps,
  person: DepositPerson,
  hint: string | undefined,
): Promise<WalletBalance> {
  deps.limiter?.take(person.userId, "balance");
  const wallet = chooseDepositWallet(person, hint);
  try {
    return await deps.reader.read(wallet.address);
  } catch {
    throw new DepositError("BALANCE_UNAVAILABLE", "We couldn't read your wallet balance just now. Pull to refresh in a moment.");
  }
}
