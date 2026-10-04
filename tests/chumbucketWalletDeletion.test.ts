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
import { loadConfig } from "../src/config.ts";
import type { WalletBalance } from "../src/deposits/balance.ts";
import type { PantaPosition, PantaPositionStatus, PantaPositionsPage } from "../src/prediction/PantaPositions.ts";
import { resolveTrustConfig } from "../src/trust/config.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin } from "../src/trust/store.ts";
import { accountDeletionGuards, deletionGuardsFor } from "../src/trust/deletionGuards.ts";
import {
  CASH_OUT_FIRST,
  ChumbucketFundsGuard,
  FUNDS_UNREADABLE,
  SOL_DUST_LAMPORTS,
  USDC_DUST_BASE_UNITS,
  cashOutFirst,
  cashOutFirstGuard,
  type FundsVerdict,
} from "../src/wallet/deletionGuard.ts";
import { FakeIdentityStore, FakeJwtVerifier } from "./authIdentityFixtures.ts";
import { harness, person, testApp } from "./socialCallsFixtures.ts";

const OWN = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const APP = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

function guard(over: {
  links?: Array<{ address: string; walletType: string }> | "down";
  balance?: { usdc?: bigint; lamports?: bigint } | "down" | null;
  positions?: Array<{ owner: string; status: PantaPositionStatus }> | "down" | null;
  holdings?: PantaPositionsPage["holdings"];
} = {}) {
  const reads: string[] = [];
  const g = new ChumbucketFundsGuard({
    links: {
      activeVerified: async () => {
        if (over.links === "down") throw new Error("synthetic");
        return (over.links ?? [{ address: OWN, walletType: "chumbucket" }, { address: APP, walletType: "mwa" }]).map((l) => ({ ...l, primary: false }));
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
            positions: async () => {
              if (over.positions === "down") throw new Error("synthetic");
              return {
                positions: (over.positions ?? []).map((p) => ({ ...p }) as unknown as PantaPosition),
                holdings: over.holdings ?? "live",
              } as PantaPositionsPage;
            },
          },
  });
  return { g, reads };
}

describe("the Chumbucket wallet must be empty", () => {
  test("no Chumbucket wallet: clear, and nothing is read", async () => {
    const { g, reads } = guard({ links: [{ address: APP, walletType: "mwa" }] });
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

  test("an open position or unclaimed winnings on it is money; another wallet's is not", async () => {
    for (const status of ["pending", "open", "awaiting_result", "won_claimable", "claiming"] as const) {
      expect(await guard({ positions: [{ owner: OWN, status }] }).g.verdict("u-ann")).toBe("funds");
    }
    expect(await guard({ positions: [{ owner: APP, status: "open" }] }).g.verdict("u-ann")).toBe("clear");
    for (const status of ["claimed", "lost", "void", "failed", "won"] as const) {
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
      deletionGuards: [
        cashOutFirstGuard({
          verdict: async (userId) => {
            asked.push(userId);
            if (verdict === "throws") throw new Error("synthetic");
            return verdict;
          },
        }),
      ],
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

describe("registered in src/trust/deletionGuards.ts", () => {
  test("the one deletion registry holds 'Cash out first'; nothing runs it separately", () => {
    expect(accountDeletionGuards).toContain(cashOutFirst);
  });

  test("by default, a links read that fails refuses the deletion (fail closed)", async () => {
    // Supabase at a closed loopback port: linked_wallets cannot be read.
    const cfg = loadConfig({ SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "synthetic-only" });
    const guards = deletionGuardsFor(cfg);
    expect(guards).toHaveLength(accountDeletionGuards.length);
    const subject = { userId: "10000000-0000-4000-8000-000000000001", authUserId: "20000000-0000-4000-8000-000000000001" };
    await expect((async () => { for (const g of guards) await g(subject); })()).rejects.toMatchObject({ code: "TRUST_FUNDS_REMAIN", message: FUNDS_UNREADABLE });
  });

  test("the guard refuses anything but a clear answer", async () => {
    const strange = cashOutFirstGuard({ verdict: async () => "maybe" as unknown as FundsVerdict });
    await expect(strange({ userId: "u-ann", authUserId: "auth-ann" })).rejects.toMatchObject({ message: FUNDS_UNREADABLE });
    await cashOutFirstGuard({ verdict: async () => "clear" })({ userId: "u-ann", authUserId: "auth-ann" });
  });
});
