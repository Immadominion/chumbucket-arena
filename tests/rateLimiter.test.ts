import { describe, expect, test } from "bun:test";
import { RateLimiter, type RateLimitConfig } from "../src/engine/RateLimiter.ts";
import { DomainError } from "../src/domain/errors.ts";

const cfg: RateLimitConfig = {
  chat: { capacity: 5, refillMs: 60_000 },
  verdict: { capacity: 2, refillMs: 300_000 },
  preBetRead: { capacity: 10, refillMs: 15_000 },
  globalDailyCap: 1000,
};

/** Charge once and report whether it was allowed (no throw) or RATE_LIMITED. */
const tryCharge = (rl: RateLimiter, endpoint: "chat" | "verdict" | "preBetRead", w: string, now: number) => {
  try {
    rl.charge(endpoint, w, now);
    return { ok: true as const };
  } catch (e) {
    if (e instanceof DomainError && e.code === "RATE_LIMITED") return { ok: false as const, e };
    throw e;
  }
};

describe("RateLimiter", () => {
  test("allows a full burst, then rejects the next request", () => {
    const rl = new RateLimiter(cfg);
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(tryCharge(rl, "chat", "alice", t).ok).toBe(true);
    const sixth = tryCharge(rl, "chat", "alice", t);
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) expect(sixth.e.code).toBe("RATE_LIMITED");
  });

  test("refills one token after refillMs elapses", () => {
    const rl = new RateLimiter(cfg);
    const t = 2_000_000;
    for (let i = 0; i < 5; i++) rl.charge("chat", "bob", t); // drain
    expect(tryCharge(rl, "chat", "bob", t + 30_000).ok).toBe(false); // half a token — still blocked
    expect(tryCharge(rl, "chat", "bob", t + 60_000).ok).toBe(true); // one token back
    expect(tryCharge(rl, "chat", "bob", t + 60_000).ok).toBe(false); // and immediately spent
  });

  test("per-wallet isolation — one wallet draining doesn't block another", () => {
    const rl = new RateLimiter(cfg);
    const t = 3_000_000;
    for (let i = 0; i < 5; i++) rl.charge("chat", "carol", t);
    expect(tryCharge(rl, "chat", "carol", t).ok).toBe(false);
    expect(tryCharge(rl, "chat", "dave", t).ok).toBe(true); // fresh bucket
  });

  test("verdict bucket is independent of chat and enforces the 5-minute cadence", () => {
    const rl = new RateLimiter(cfg);
    const t = 4_000_000;
    expect(tryCharge(rl, "verdict", "erin", t).ok).toBe(true);
    expect(tryCharge(rl, "verdict", "erin", t).ok).toBe(true); // burst of 2
    expect(tryCharge(rl, "verdict", "erin", t).ok).toBe(false);
    expect(tryCharge(rl, "verdict", "erin", t + 299_000).ok).toBe(false); // not quite 5 min
    expect(tryCharge(rl, "verdict", "erin", t + 300_000).ok).toBe(true); // 5 min → one back
    // ...and chat for the same wallet is untouched.
    expect(tryCharge(rl, "chat", "erin", t).ok).toBe(true);
  });

  test("global daily cap stops fresh wallets once the ceiling is hit", () => {
    const rl = new RateLimiter({ ...cfg, globalDailyCap: 3 });
    const t = 5_000_000;
    expect(tryCharge(rl, "chat", "w1", t).ok).toBe(true);
    expect(tryCharge(rl, "chat", "w2", t).ok).toBe(true);
    expect(tryCharge(rl, "chat", "w3", t).ok).toBe(true);
    const capped = tryCharge(rl, "chat", "w4", t); // brand-new wallet, but cap reached
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.e.details?.scope).toBe("global");
  });

  test("global counter resets on a new UTC day", () => {
    const rl = new RateLimiter({ ...cfg, globalDailyCap: 1 });
    const day1 = Date.parse("2026-06-22T10:00:00Z");
    const day2 = Date.parse("2026-06-23T10:00:00Z");
    expect(tryCharge(rl, "chat", "w1", day1).ok).toBe(true);
    expect(tryCharge(rl, "chat", "w2", day1).ok).toBe(false); // cap of 1 hit
    expect(tryCharge(rl, "chat", "w3", day2).ok).toBe(true); // new day, counter reset
  });

  test("a rejected request does not consume global budget", () => {
    const rl = new RateLimiter({ ...cfg, globalDailyCap: 2, chat: { capacity: 1, refillMs: 60_000 } });
    const t = 6_000_000;
    expect(tryCharge(rl, "chat", "x", t).ok).toBe(true); // x: 1 used, global 1/2
    expect(tryCharge(rl, "chat", "x", t).ok).toBe(false); // x bucket empty — must NOT spend global
    expect(tryCharge(rl, "chat", "y", t).ok).toBe(true); // global still has room (1 left)
    expect(tryCharge(rl, "chat", "z", t).ok).toBe(false); // now global cap (2) reached
  });
});
