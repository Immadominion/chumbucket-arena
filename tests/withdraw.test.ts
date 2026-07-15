/**
 * Two-phase withdraw (fund safety). The ledger debit lands BEFORE the on-chain
 * send, so a crash after the send can never double-pay; a failed send reverses
 * the debit so no balance is lost. These lock in both directions.
 */

import { describe, expect, test } from "bun:test";
import { appRouter } from "../src/api/router.ts";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { asWallet, wal, type Frost, type Wallet } from "../src/domain/ids.ts";
import type { Custody, CustodyRef } from "../src/ports/Custody.ts";

const FIXED_NOW = 1_750_000_000_000;

function makeCustody(opts: { failWithdraw?: boolean }): Custody {
  return {
    sessionsAddress: () => "0xsessions",
    async confirmDeposit(_w: Wallet, _a: Frost, proof?: string): Promise<CustodyRef> {
      return { ref: proof ?? "dep" };
    },
    async withdraw(): Promise<CustodyRef> {
      if (opts.failWithdraw) throw new Error("chain send failed");
      return { ref: "wtx" };
    },
  };
}

describe("two-phase withdraw", () => {
  test("a confirmed send debits the gross exactly once", async () => {
    const app = await createApp({ config: loadConfig({}), now: FIXED_NOW, custody: makeCustody({}) });
    const al = appRouter.createCaller({ app, wallet: asWallet("0xw1") });
    await al.signContract({ handle: "W1" });
    await al.deposit({ amount: wal(100) });

    const res = await al.withdraw({ amount: wal(5) });
    expect(res.fee).toBe(100_000n); // max(2% of 5, 0.05 USDC flat) = 0.1 USDC
    expect(res.net).toBe(4_900_000n); // player receives gross − fee

    const me = await al.me();
    expect(me!.balance).toBe(wal(95)); // gross 5 debited once, no more
  });

  test("a failed on-chain send reverses the debit — no balance lost", async () => {
    const app = await createApp({ config: loadConfig({}), now: FIXED_NOW, custody: makeCustody({ failWithdraw: true }) });
    const al = appRouter.createCaller({ app, wallet: asWallet("0xw2") });
    await al.signContract({ handle: "W2" });
    await al.deposit({ amount: wal(100) });

    await expect(al.withdraw({ amount: wal(5) })).rejects.toThrow();

    const me = await al.me();
    expect(me!.balance).toBe(wal(100)); // Initiated debit was reversed on failure
  });
});
