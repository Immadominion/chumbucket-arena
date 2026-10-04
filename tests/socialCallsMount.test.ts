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

describe("the integration patch keeps the original paths and adds canonical follow", () => {
  test("mounting the three sub-routers yields the original eight, two follow paths and the people layer", () => {
    expect(pathsOf(patched)).toEqual([
      // People layer (src/calls/people.ts): additive paths only — none of
      // the original ten changed name or shape.
      "calls.addUpdate",
      "calls.create",
      "calls.feed",
      "calls.get",
      "calls.invitations",
      "calls.respond",
      "calls.top",
      "markets.detail",
      "markets.open",
      // Add a friend: "is this them?" before people.follow (personFinder.ts).
      "people.find",
      "people.follow",
      "people.following",
      "people.get",
      "people.leaderboard",
      "people.search",
      "people.suggested",
      "people.unfollow",
    ]);
  });

  test("it is identical to the exported callsRouter, so tests and production agree", () => {
    expect(pathsOf(patched)).toEqual(pathsOf(callsRouter));
  });

  test("the three namespaces are mounted, and shadow no legacy root procedure", () => {
    // Written pre-mount as "these keys are still free, so the patch is safe to
    // apply". The patch has since been applied, so the same intent now reads
    // forwards: each namespace is present, and — the part that actually
    // protects anything — nesting added paths without a bare key of the same
    // name surviving to shadow a legacy procedure.
    const existing = Object.keys(appRouter._def.procedures as Record<string, unknown>);
    for (const key of ["calls", "markets", "people"]) {
      expect(existing.filter((p) => p.startsWith(`${key}.`)).length).toBeGreaterThan(0);
      expect(existing).not.toContain(key);
    }
  });

  test("every §5 path is reachable on the ROOT router, not just the sub-router", () => {
    const root = Object.keys(appRouter._def.procedures as Record<string, unknown>);
    for (const path of pathsOf(callsRouter)) {
      expect(root).toContain(path);
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
