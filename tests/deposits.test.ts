/**
 * Custodial deposit flow: sweeps detected by the gateway are credited to the
 * player's ledger exactly once — idempotent and reconciled across repeated calls
 * (the "check for my deposit" button is safe to mash).
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type Frost, type Wallet } from "../src/domain/ids.ts";
import type { Custody, CustodyRef } from "../src/ports/Custody.ts";
import type { DepositCredit, DepositGateway, PrivyPlayer } from "../src/ports/PrivyDepositGateway.ts";

const FIXED_NOW = 1_750_000_000_000;

// Like real SolanaCustody/PrivyCustody: confirms a deposit by echoing the proof
// as the ref, so the per-signature replay guard dedups correctly.
const echoCustody: Custody = {
  sessionsAddress: () => "0xsessions",
  async confirmDeposit(_w: Wallet, _a: Frost, proof?: string): Promise<CustodyRef> {
    return { ref: proof ?? "noproof" };
  },
  async withdraw(): Promise<CustodyRef> {
    return { ref: "w" };
  },
};

const gatewayReturning = (ref: { current: DepositCredit[] }): DepositGateway => ({
  async collect(_p: PrivyPlayer): Promise<DepositCredit[]> {
    return ref.current;
  },
});

describe("custodial deposits (sweep + credit)", () => {
  test("sweeps credited once — idempotent + reconciled across calls", async () => {
    const script = { current: [] as DepositCredit[] };
    const app = await createApp({
      config: loadConfig({}),
      now: FIXED_NOW,
      custody: echoCustody,
      depositGateway: gatewayReturning(script),
    });
    await app.engine.syncFixtures();

    const alice = appRouter.createCaller({
      app,
      wallet: asWallet("0xalice"),
      privyWalletId: "wid_alice",
    });
    await alice.signContract({ handle: "Alice" });

    // First sweep detected → credited.
    script.current = [{ signature: "sweep1", amount: wal(5) }];
    let r = await alice.syncDeposit();
    expect(r.credited).toBe(wal(5));
    expect((await alice.me())!.balance).toBe(wal(5));

    // Same signature re-presented (reconcile) → NOT double-credited.
    r = await alice.syncDeposit();
    expect(r.credited).toBe(0n);
    expect((await alice.me())!.balance).toBe(wal(5));

    // A new sweep alongside the old → only the new amount is credited.
    script.current = [
      { signature: "sweep1", amount: wal(5) },
      { signature: "sweep2", amount: wal(3) },
    ];
    r = await alice.syncDeposit();
    expect(r.credited).toBe(wal(3));
    expect((await alice.me())!.balance).toBe(wal(8));
  });

  test("no-op for a player without a Privy wallet (dev/play-money)", async () => {
    const script = { current: [{ signature: "x", amount: wal(9) }] };
    const app = await createApp({
      config: loadConfig({}),
      now: FIXED_NOW,
      custody: echoCustody,
      depositGateway: gatewayReturning(script),
    });
    await app.engine.syncFixtures();
    const anon = appRouter.createCaller({ app, wallet: asWallet("0xnopriv") }); // no privy wallet
    await anon.signContract({});
    const r = await anon.syncDeposit();
    expect(r.credited).toBe(0n); // gateway never consulted without a Privy wallet
  });

  test("depositAddress returns the player's wallet + availability", async () => {
    const app = await createApp({
      config: loadConfig({}),
      now: FIXED_NOW,
      custody: echoCustody,
      depositGateway: gatewayReturning({ current: [] }),
    });
    const alice = appRouter.createCaller({
      app,
      wallet: asWallet("0xalice"),
      privyWalletId: "wid",
    });
    const a = await alice.depositAddress();
    expect(a.address).toBe(asWallet("0xalice"));
    expect(a.available).toBe(true);
  });
});
