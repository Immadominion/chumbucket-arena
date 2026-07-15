import { describe, expect, test } from "bun:test";
import { DevAuth } from "../src/auth/DevAuth.ts";
import { makeContext } from "../src/api/trpc.ts";
import type { App } from "../src/app.ts";
import { asWallet } from "../src/domain/ids.ts";

describe("auth", () => {
  test("DevAuth maps a credential to a wallet, rejects empty", async () => {
    const auth = new DevAuth();
    const u = await auth.verify("0xABC");
    expect(u?.wallet).toBe(asWallet("0xABC"));
    expect(u?.userId).toBe("dev:0xABC"); // case preserved — Solana addresses are case-sensitive
    expect(await auth.verify("")).toBeNull();
    expect(await auth.verify("   ")).toBeNull();
  });

  test("makeContext attaches the wallet for a valid token, omits it otherwise", async () => {
    const app = { auth: new DevAuth() } as unknown as App;
    expect((await makeContext(app, "0xfeed")).wallet).toBe(asWallet("0xfeed"));
    expect((await makeContext(app, undefined)).wallet).toBeUndefined();
    expect((await makeContext(app, "")).wallet).toBeUndefined();
  });
});
