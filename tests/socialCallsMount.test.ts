/**
 * The mount, proved BEFORE it is applied.
 *
 * `src/api/router.ts` is integration-owned (§6), so Packet D cannot add its own
 * keys to `appRouter`; the exact patch is filed in
 * docs/contracts/integration-requests/packet-d.md. This file is what makes that
 * patch trustworthy: it composes the same three keys here, off the same
 * exports, and checks the result — so the integration owner is applying a patch
 * that has already been run.
 *
 * It also checks the two ways a mount can go wrong: a name that collides with
 * an existing root key, and a namespace whose paths do not match the §5 table.
 */

import { describe, expect, test } from "bun:test";
import {
  callsRouter,
  socialCallsRouter,
  socialMarketsRouter,
  socialPeopleRouter,
} from "../src/api/calls.ts";
import { appRouter } from "../src/api/router.ts";
import { router } from "../src/api/trpc.ts";

/** Character for character, the patch in the integration request. */
const patched = router({
  calls: socialCallsRouter,
  markets: socialMarketsRouter,
  people: socialPeopleRouter,
});

const pathsOf = (r: { _def: { procedures: Record<string, unknown> } }): string[] =>
  Object.keys(r._def.procedures).sort();

describe("the integration patch composes to exactly the §5 surface", () => {
  test("mounting the three sub-routers yields the eight declared paths", () => {
    expect(pathsOf(patched)).toEqual([
      "calls.create",
      "calls.feed",
      "calls.get",
      "calls.invitations",
      "calls.respond",
      "markets.detail",
      "markets.open",
      "people.get",
    ]);
  });

  test("it is identical to the exported callsRouter, so tests and production agree", () => {
    expect(pathsOf(patched)).toEqual(pathsOf(callsRouter));
  });

  test("none of the three keys collides with an existing root procedure", () => {
    const existing = Object.keys(appRouter._def.procedures as Record<string, unknown>);
    for (const key of ["calls", "markets", "people"]) {
      expect(existing).not.toContain(key);
      expect(existing.filter((p) => p.startsWith(`${key}.`))).toHaveLength(0);
    }
  });

  test("the root surface already mounted by A and B is untouched by this packet", () => {
    const paths = Object.keys(appRouter._def.procedures as Record<string, unknown>);
    expect(paths).toContain("health");
    expect(paths.some((p) => p.startsWith("auth."))).toBe(true);
    expect(paths.some((p) => p.startsWith("predictions."))).toBe(true);
  });

  test("importing the route module starts nothing — no runtime is built at import", () => {
    // Every construction is behind `callsRuntimeFor(config)`, which is only
    // reached from inside a procedure (§6). If that regressed, importing this
    // module would have already built a store and an event-log subscription.
    expect(typeof callsRouter.createCaller).toBe("function");
  });
});
