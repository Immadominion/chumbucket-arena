/**
 * Deleting an account never strands money in its Chumbucket wallet
 * (src/wallet/deletionGuard.ts, TrustService.deleteAccount): only that
 * account can reach the wallet. Doubles stand in for linked_wallets, the RPC
 * and Panta positions; addresses are synthetic.
 */

import { describe, expect, test } from "bun:test";
import { authRouter } from "../src/api/authRoutes.ts";
import { primeAuthIdentityRuntime, resolveAuthIdentityPolicy } from "../src/auth/AuthIdentityRuntime.ts";
import { setCallsRuntime } from "../src/calls/runtime.ts";
import type { WalletBalance } from "../src/deposits/balance.ts";
import type { PantaPosition, PantaPositionStatus, PantaPositionsPage } from "../src/prediction/PantaPositions.ts";
import { resolveTrustConfig } from "../src/trust/config.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin } from "../src/trust/store.ts";
import { CASH_OUT_FIRST, FUNDS_UNREADABLE } from "../src/trust/TrustService.ts";
import { ChumbucketFundsGuard, SOL_DUST_LAMPORTS, SupabaseChumbucketLinks, USDC_DUST_BASE_UNITS, type FundsVerdict } from "../src/wallet/deletionGuard.ts";
import { SupabasePantaTradingStore } from "../src/prediction/PantaTradingStore.ts";
import { PantaPositionsService } from "../src/prediction/PantaPositions.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";
import { harness, person, testApp } from "./socialCallsFixtures.ts";

const OWN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const APP = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

function guard(over: {
  /** The account's Chumbucket wallets, active or revoked (what the reader answers). */
  links?: string[] | "down";
  balance?: { usdc?: bigint; lamports?: bigint } | "down" | null;
  positions?: Array<{ owner: string; status: PantaPositionStatus; walletShares?: string | null; claim?: { state: string } | null }> | "down" | null;
  holdings?: PantaPositionsPage["holdings"];
} = {}) {
  const reads: string[] = [];
  const positionReads: unknown[] = [];
  const g = new ChumbucketFundsGuard({
    links: {
      chumbucketWallets: async () => {
        if (over.links === "down") throw new Error("synthetic");
        return over.links ?? [OWN];
      },
    },
    balances:
      over.balance === null
        ? null
        : {
            read: async (wallet: string): Promise<WalletBalance> => {
              reads.push(wallet);
              if (over.balance === "down") throw new Error("synthetic");
              const b = over.balance ?? {};
              return { wallet, network: "solana-mainnet", lamports: String(b.lamports ?? 0n), usdcBaseUnits: String(b.usdc ?? 0n), slot: 1, readAt: "2026-10-04T12:00:00.000Z" };
            },
          },
    positions: () =>
      over.positions === null
        ? null
        : {
            positions: async (_userId: string, opts: { all: true }) => {
              positionReads.push(opts);
              if (over.positions === "down") throw new Error("synthetic");
              return {
                positions: (over.positions ?? []).map((p) => ({ walletShares: null, claim: null, ...p }) as unknown as PantaPosition),
                holdings: over.holdings ?? "live",
              } as PantaPositionsPage;
            },
          },
  });
  return { g, reads, positionReads };
}

describe("the Chumbucket wallet must be empty", () => {
  test("no Chumbucket wallet: clear, and nothing is read", async () => {
    const { g, reads } = guard({ links: [] });
    expect(await g.verdict("u-ann")).toBe("clear");
    expect(reads).toEqual([]);
  });

  test("USDC or SOL above dust is money; dust and a wallet app's balance are not", async () => {
    expect(await guard({ balance: { usdc: USDC_DUST_BASE_UNITS } }).g.verdict("u-ann")).toBe("funds");
    expect(await guard({ balance: { lamports: SOL_DUST_LAMPORTS } }).g.verdict("u-ann")).toBe("funds");
    const dust = guard({ balance: { usdc: USDC_DUST_BASE_UNITS - 1n, lamports: SOL_DUST_LAMPORTS - 1n } });
    expect(await dust.g.verdict("u-ann")).toBe("clear");
    expect(dust.reads).toEqual([OWN]);
  });

  test("every position is read, and a void one owes its stake until claimed or emptied", async () => {
    const all = guard();
    expect(await all.g.verdict("u-ann")).toBe("clear");
    expect(all.positionReads).toEqual([{ all: true }]);
    expect(await guard({ positions: [{ owner: OWN, status: "void", walletShares: "12.5" }] }).g.verdict("u-ann")).toBe("funds");
    expect(await guard({ positions: [{ owner: OWN, status: "void", walletShares: "12.5" }], holdings: "unavailable" }).g.verdict("u-ann")).toBe("unknown");
    expect(await guard({ positions: [{ owner: OWN, status: "void", walletShares: "12.5", claim: { state: "CONFIRMED" } }] }).g.verdict("u-ann")).toBe("clear");
    expect(await guard({ positions: [{ owner: OWN, status: "void", walletShares: "0" }] }).g.verdict("u-ann")).toBe("clear");
    expect(await guard({ positions: [{ owner: OWN, status: "void", walletShares: null }] }).g.verdict("u-ann")).toBe("clear");
  });

  test("a revoked Chumbucket wallet still counts: its key went nowhere", async () => {
    // The reader answers revoked links too; the guard checks each one.
    const both = guard({ links: [OWN, APP], balance: { usdc: 0n } });
    expect(await both.g.verdict("u-ann")).toBe("clear");
    expect(both.reads).toEqual([OWN, APP]);
  });

  test("an open position or unclaimed winnings on it is money; another wallet's is not", async () => {
    for (const status of ["pending", "open", "awaiting_result", "won_claimable", "claiming"] as const) {
      expect(await guard({ positions: [{ owner: OWN, status }] }).g.verdict("u-ann")).toBe("funds");
    }
    expect(await guard({ positions: [{ owner: APP, status: "open" }] }).g.verdict("u-ann")).toBe("clear");
    for (const status of ["claimed", "lost", "failed", "won"] as const) {
      expect(await guard({ positions: [{ owner: OWN, status }] }).g.verdict("u-ann")).toBe("clear");
    }
    // A win whose claimability Panta did not answer for may still pay.
    expect(await guard({ positions: [{ owner: OWN, status: "won" }], holdings: "unavailable" }).g.verdict("u-ann")).toBe("unknown");
  });

  test("anything unreadable fails closed", async () => {
    for (const over of [{ links: "down" as const }, { balance: "down" as const }, { balance: null }, { positions: null }, { positions: "down" as const }]) {
      expect(await guard(over).g.verdict("u-ann")).toBe("unknown");
    }
  });
});

describe("the readers behind it", () => {
  test("Chumbucket links: this account, this label, revoked included; a full page is refused", async () => {
    const urls: URL[] = [];
    const rows = (n: number) => Array.from({ length: n }, () => ({ wallet_address: OWN }));
    const reader = (answer: unknown, status = 200) =>
      new SupabaseChumbucketLinks({ supabaseUrl: "https://synthetic.invalid", serviceRoleKey: "synthetic-only" },
        Object.assign(async (url: Parameters<typeof fetch>[0]) => {
          urls.push(new URL(String(url)));
          return new Response(JSON.stringify(answer), { status });
        }, { preconnect: fetch.preconnect }) as typeof fetch);
    const user = "10000000-0000-4000-8000-000000000001";
    expect(await reader(rows(2)).chumbucketWallets(user)).toEqual([OWN, OWN]);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ user_id: `eq.${user}`, wallet_type: "eq.chumbucket", select: "wallet_address", limit: "100" });
    await expect(reader(rows(100)).chumbucketWallets(user)).rejects.toThrow();
    await expect(reader({ message: "no" }, 500).chumbucketWallets(user)).rejects.toThrow();
    await expect(reader([]).chumbucketWallets("u-ann")).rejects.toThrow();
  });

  test("positions({ all }) reads every order, and refuses on a ledger that cannot", async () => {
    const calls: string[] = [];
    const base = { markets: { getMarket: () => undefined, getResolution: () => undefined }, claims: null, holdings: null } as never;
    const newest = new PantaPositionsService({ ...(base as object), ledger: { listForUser: async () => { calls.push("newest"); return []; } } } as never);
    await expect(newest.positions("u-ann", { all: true })).rejects.toThrow("cannot read every order");
    const every = new PantaPositionsService({ ...(base as object), ledger: {
      listForUser: async () => { calls.push("newest"); return []; },
      listAllForUser: async () => { calls.push("all"); return []; },
    } } as never);
    await every.positions("u-ann", { all: true });
    await every.positions("u-ann");
    expect(calls).toEqual(["all", "newest"]);
  });

  test("every order is read, page by page, never a silent truncation", async () => {
    const offsets: string[] = [];
    let total = 450;
    const store = new SupabasePantaTradingStore({ supabaseUrl: "https://synthetic.invalid", serviceRoleKey: "synthetic-only" },
      Object.assign(async (url: Parameters<typeof fetch>[0]) => {
        const params = new URL(String(url)).searchParams;
        const offset = Number(params.get("offset"));
        offsets.push(String(offset));
        const n = Math.max(0, Math.min(200, total - offset));
        return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `r${offset + i}` }))), { status: 200 });
      }, { preconnect: fetch.preconnect }) as typeof fetch);
    expect(await store.listAllForUser("10000000-0000-4000-8000-000000000001")).toHaveLength(450);
    expect(offsets).toEqual(["0", "200", "400"]);
    total = 1_000_000;
    await expect(store.listAllForUser("10000000-0000-4000-8000-000000000001")).rejects.toThrow("more rows");
  });
});

describe("auth.deleteAccount", () => {
  async function scene(verdict: FundsVerdict | "throws") {
    const h = harness({ people: [person("u-ann")], markets: [] });
    const app = await testApp();
    setCallsRuntime(app.config, h.rt);
    const store = new InMemoryTrustStore();
    const authAdmin = new RecordingAuthUserAdmin();
    const asked: string[] = [];
    const trust = buildTrustRuntime(app.config, {
      config: resolveTrustConfig(app.config, {}),
      store,
      authAdmin,
      now: () => h.clock.now(),
      funds: {
        verdict: async (userId) => {
          asked.push(userId);
          if (verdict === "throws") throw new Error("synthetic");
          return verdict;
        },
      },
    });
    setTrustRuntime(app.config, trust);
    const identity = new FakeIdentityStore().addUser("auth-ann", "u-ann");
    primeAuthIdentityRuntime(app.config, { store: identity, verifier: new FakeJwtVerifier().issue("tok-ann", "auth-ann"), policy: resolveAuthIdentityPolicy(app.config) });
    return { asked, authAdmin, account: authRouter.createCaller({ app, supabaseAccessToken: "tok-ann" }) };
  }

  test("money in the Chumbucket wallet: 'Cash out first', and nothing is deleted", async () => {
    const s = await scene("funds");
    await expect(s.account.deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: CASH_OUT_FIRST });
    expect(s.asked).toEqual(["u-ann"]);
    expect(s.authAdmin.deleted).toEqual([]);
  });

  test("unreadable: refused, never assumed empty", async () => {
    for (const verdict of ["unknown", "throws"] as const) {
      const s = await scene(verdict);
      await expect(s.account.deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: FUNDS_UNREADABLE });
      expect(s.authAdmin.deleted).toEqual([]);
    }
  });

  test("an empty wallet deletes as before", async () => {
    const s = await scene("clear");
    expect(await s.account.deleteAccount({ confirm: "DELETE" })).toMatchObject({ status: "deleted", userId: "u-ann" });
    expect(s.authAdmin.deleted).toEqual(["auth-ann"]);
  });
});
