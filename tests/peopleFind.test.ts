/**
 * people.find — the add-a-friend confirmation card.
 *
 * What these tests hold it to:
 *   - a session is required, and the lookup is rate-limited per person;
 *   - an X profile link looks up X accounts only; @name looks up both an X
 *     account and a Chumbucket @username, X first; a wallet finds the real
 *     person holding it;
 *   - every match is the same PersonCard the lists show (record and
 *     viewerIsFollowing included), plus the X handle and X picture when the
 *     person signed in with X, and whether it is the viewer;
 *   - an X handle nobody here has comes back as "not on Chumbucket", with a
 *     public X picture only when one was found — never a stand-in;
 *   - nothing is written, no wallet is ever echoed or attached, and a lookup
 *     that cannot run fails instead of claiming nobody matched;
 *   - deleted accounts are never offered.
 */

import { describe, expect, test } from "bun:test";
import { callsRouter } from "../src/api/calls.ts";
import { READ_ONLY_MUTATIONS } from "../src/api/writeLimits.ts";
import { findPerson, parseFindQuery, type PersonIdentityReader, type XIdentity } from "../src/calls/personFinder.ts";
import { buildCallsRuntime, setCallsRuntime } from "../src/calls/runtime.ts";
import { InMemoryCallsStore } from "../src/calls/store.ts";
import type { XAvatarLookup } from "../src/calls/xAvatars.ts";
import { asWallet } from "../src/domain/ids.ts";
import { resolveTrustConfig } from "../src/trust/config.ts";
import { buildTrustRuntime, setTrustRuntime } from "../src/trust/runtime.ts";
import { InMemoryTrustStore, RecordingAuthUserAdmin } from "../src/trust/store.ts";
import { assertMoneyFree } from "../src/calls/types.ts";
import { harness, market, person, testApp, type Harness } from "./socialCallsFixtures.ts";

/** A real, holdable Solana address (on the curve, not small order). */
const FRIEND_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PIC = "https://pbs.twimg.com/profile_images/1/irfan_400x400.jpg";

interface FakeIdentities extends PersonIdentityReader {
  asked: string[];
}

function identities(opts: {
  x?: XIdentity[];
  wallets?: Record<string, string>;
  fail?: boolean;
} = {}): FakeIdentities {
  const asked: string[] = [];
  const fail = () => {
    if (opts.fail) throw new Error("rpc/person_x_identities_v1 HTTP 404 (PGRST202)");
  };
  return {
    asked,
    async byXHandle(handle) {
      asked.push(`x:${handle}`);
      fail();
      return (opts.x ?? []).filter((x) => x.xHandle.toLowerCase() === handle);
    },
    async xIdentitiesOf(ids) {
      asked.push(`ids:${[...ids].sort().join(",")}`);
      fail();
      return (opts.x ?? []).filter((x) => ids.includes(x.userId));
    },
    async personForWallet(wallet) {
      asked.push(`wallet`);
      fail();
      return opts.wallets?.[wallet] ?? null;
    },
  };
}

function avatars(map: Record<string, string> = {}): XAvatarLookup & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async avatarFor(handle) {
      asked.push(handle);
      return map[handle] ?? null;
    },
  };
}

function scene(): Harness {
  const h = harness({
    people: [
      person("u-me", { handle: "dominion", displayName: "Dominion" }),
      person("u-irf", { handle: "irfan_calls", displayName: "Irfan", avatarId: 3 }),
      person("u-name", { handle: "irfan", displayName: "Another Irfan" }),
      person("u-wal", { handle: "walletpal", displayName: "Wallet Pal", walletAddress: FRIEND_WALLET }),
      person("u-gone", { handle: "deleted_0123456789ab", displayName: "Deleted account" }),
      person("u-long", { handle: "a_really_long_name_1", displayName: "Long Name" }),
    ],
    markets: [market("m-1")],
  });
  return h;
}

async function routes(h: Harness) {
  const app = await testApp();
  setCallsRuntime(app.config, h.rt);
  const trust = buildTrustRuntime(app.config, {
    config: resolveTrustConfig(app.config, {}),
    store: new InMemoryTrustStore(),
    authAdmin: new RecordingAuthUserAdmin(),
    now: () => h.clock.now(),
  });
  setTrustRuntime(app.config, trust);
  const as = (id: string) => callsRouter.createCaller({ app, wallet: asWallet(`Wallet_${id}`) });
  return { anon: callsRouter.createCaller({ app }), as, trust };
}

const irfanX: XIdentity = { userId: "u-irf", xHandle: "Irfan", xAvatarUrl: PIC, seenAt: 2 };

describe("parseFindQuery", () => {
  test("X profile links mean X accounts only", () => {
    for (const link of [
      "https://x.com/Irfan",
      "x.com/irfan",
      "www.x.com/irfan/",
      "https://twitter.com/irfan?s=20",
      "http://mobile.twitter.com/irfan",
      "https://x.com/irfan/status/1840000000000000000",
    ]) {
      expect(parseFindQuery(link), link).toEqual({ kind: "x", xHandle: "irfan", username: null, wallet: null });
    }
  });

  test("@name and name can be an X account and a @username", () => {
    expect(parseFindQuery("  @Irfan ")).toEqual({ kind: "handle", xHandle: "irfan", username: "irfan", wallet: null });
    // Too short for a @username (3–20), fine for X (1–15).
    expect(parseFindQuery("@ab")).toEqual({ kind: "handle", xHandle: "ab", username: null, wallet: null });
    // Too long for X (15), fine for a @username (20).
    expect(parseFindQuery("a_really_long_name_1")).toEqual({
      kind: "handle", xHandle: null, username: "a_really_long_name_1", wallet: null,
    });
  });

  test("a holdable Solana wallet", () => {
    expect(parseFindQuery(` ${FRIEND_WALLET} `)).toEqual({
      kind: "wallet", xHandle: null, username: null, wallet: FRIEND_WALLET,
    });
  });

  test("anything else is refused, not guessed", () => {
    for (const bad of [
      "",
      "   ",
      "hello world",
      "alice.skr", // the phone resolves names to wallets first
      "toly.sol",
      "https://example.com/irfan",
      "https://x.com/home",
      "https://x.com/i/web/status/1",
      "https://x.com/",
      "https://user:pw@x.com/irfan",
      "https://x.com:8443/irfan",
      "ftp://x.com/irfan",
      "@way_too_long_for_anything_at_all",
      "irfan!",
      "11111111111111111111111111111111", // not a holdable key
    ]) {
      expect(parseFindQuery(bad), bad).toBeNull();
    }
  });
});

describe("people.find", () => {
  test("needs a session; a signed-out caller is told to sign in", async () => {
    const h = scene();
    const { anon } = await routes(h);
    await expect(anon.people.find({ query: "@irfan" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("an input that is none of the three is refused with readable copy", async () => {
    const h = scene();
    const { as } = await routes(h);
    await expect(as("u-me").people.find({ query: "alice.skr" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Enter their X handle, Chumbucket @username or Solana wallet.",
    });
  });

  test("an X handle finds the person who signed in with that X account", async () => {
    const h = scene();
    h.rt.identities = identities({ x: [irfanX] });
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: "https://x.com/IRFAN" });
    expect(found.kind).toBe("x");
    expect(found.handle).toBe("irfan");
    expect(found.notOnChumbucket).toBeNull();
    expect(found.matches).toHaveLength(1);
    const [m] = found.matches;
    expect(m).toMatchObject({
      matchedBy: "x",
      xHandle: "Irfan",
      xAvatarUrl: PIC,
      isViewer: false,
      person: { id: "u-irf", handle: "irfan_calls", displayName: "Irfan", avatarId: 3, viewerIsFollowing: false },
    });
    // The same public record people.get shows.
    expect(m!.person.record.display.mode).toBe("counts");
    // An X link never looks up the @username "irfan" (somebody else's).
    expect(found.matches.map((x) => x.person.id)).not.toContain("u-name");
  });

  test("@name is both: the X account first, then the @username someone else holds", async () => {
    const h = scene();
    const ids = identities({ x: [irfanX] });
    h.rt.identities = ids;
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: "@Irfan" });
    expect(found.matches.map((m) => [m.person.id, m.matchedBy])).toEqual([
      ["u-irf", "x"],
      ["u-name", "username"],
    ]);
    // The @username's own X account was asked for (it has none).
    expect(ids.asked).toContain("ids:u-name");
    expect(found.matches[1]).toMatchObject({ xHandle: null, xAvatarUrl: null });
  });

  test("a @username match carries that person's X account when they have one", async () => {
    const h = scene();
    h.rt.identities = identities({ x: [{ userId: "u-name", xHandle: "IrfanOnX", xAvatarUrl: PIC, seenAt: 1 }] });
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: "irfan" });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ matchedBy: "username", xHandle: "IrfanOnX", xAvatarUrl: PIC });
  });

  test("already following says so; following happens only through people.follow", async () => {
    const h = scene();
    h.rt.identities = identities({ x: [irfanX] });
    const { as } = await routes(h);
    const me = as("u-me");
    const before = await me.people.find({ query: "x.com/irfan" });
    expect(before.matches[0]!.person.viewerIsFollowing).toBe(false);
    // The lookup wrote nothing.
    expect(h.calls.isFollowing("u-me", "u-irf")).toBe(false);

    await me.people.follow({ personRef: before.matches[0]!.person.id });
    const after = await me.people.find({ query: "x.com/irfan" });
    expect(after.matches[0]!.person.viewerIsFollowing).toBe(true);

    await me.people.unfollow({ personRef: "u-irf" });
    expect((await me.people.find({ query: "x.com/irfan" })).matches[0]!.person.viewerIsFollowing).toBe(false);
  });

  test("looking yourself up says it is you", async () => {
    const h = scene();
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: "@Dominion" });
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]).toMatchObject({ isViewer: true, person: { id: "u-me", viewerIsFollowing: false } });
  });

  test("a wallet finds the real person holding it, and is never echoed back", async () => {
    const h = scene();
    h.rt.identities = identities({ wallets: { [FRIEND_WALLET]: "u-wal" } });
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: FRIEND_WALLET });
    expect(found.kind).toBe("wallet");
    expect(found.handle).toBeNull();
    expect(found.notOnChumbucket).toBeNull();
    expect(found.matches.map((m) => [m.person.id, m.matchedBy])).toEqual([["u-wal", "wallet"]]);
    const wire = JSON.stringify(found);
    expect(wire).not.toContain(FRIEND_WALLET);
    expect(wire).not.toContain("walletAddress");
    expect(wire).not.toContain("Wallet_");
    assertMoneyFree(found, "people.find");
  });

  test("a wallet nobody real holds finds nobody, with no X card to show", async () => {
    const h = scene();
    h.rt.identities = identities({ wallets: {} });
    h.rt.xAvatars = avatars();
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: FRIEND_WALLET });
    expect(found.matches).toEqual([]);
    expect(found.notOnChumbucket).toBeNull();
  });

  test("an X handle nobody here has is 'not on Chumbucket', with their public picture when found", async () => {
    const h = scene();
    const pics = avatars({ vitalik: "https://pbs.twimg.com/profile_images/9/v_400x400.jpg" });
    h.rt.identities = identities();
    h.rt.xAvatars = pics;
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: "x.com/Vitalik" });
    expect(found.matches).toEqual([]);
    expect(found.notOnChumbucket).toEqual({
      xHandle: "vitalik",
      xAvatarUrl: "https://pbs.twimg.com/profile_images/9/v_400x400.jpg",
    });
    expect(pics.asked).toEqual(["vitalik"]);

    // No picture known: null, never a stand-in.
    const nobody = await as("u-me").people.find({ query: "@nobody_here" });
    expect(nobody.notOnChumbucket).toEqual({ xHandle: "nobody_here", xAvatarUrl: null });
  });

  test("a @username too long to be an X handle finds nobody without an X card", async () => {
    const h = scene();
    h.rt.xAvatars = avatars();
    const { as } = await routes(h);
    const found = await as("u-me").people.find({ query: "@no_such_user_name_20" });
    expect(found.matches).toEqual([]);
    expect(found.notOnChumbucket).toBeNull();
    // A long @username that exists is found.
    const long = await as("u-me").people.find({ query: "a_really_long_name_1" });
    expect(long.matches.map((m) => m.person.id)).toEqual(["u-long"]);
  });

  test("deleted accounts are never offered", async () => {
    const h = scene();
    h.rt.identities = identities({ x: [{ userId: "u-gone", xHandle: "gone", xAvatarUrl: null, seenAt: 1 }] });
    h.rt.xAvatars = avatars();
    const { as } = await routes(h);
    expect((await as("u-me").people.find({ query: "deleted_0123456789ab" })).matches).toEqual([]);
    expect((await as("u-me").people.find({ query: "@gone" })).matches).toEqual([]);
  });

  test("a lookup that cannot run fails; it never claims nobody matched", async () => {
    const h = scene();
    h.rt.identities = identities({ fail: true });
    h.rt.xAvatars = avatars();
    const { as } = await routes(h);
    for (const query of ["@irfan", "x.com/irfan", FRIEND_WALLET]) {
      await expect(as("u-me").people.find({ query })).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        message: "We couldn't look that up right now. Try again in a moment.",
      });
    }
  });

  test("rate-limited per person, with the wait in words", async () => {
    const h = scene();
    const { as, trust } = await routes(h);
    for (let i = 0; i < 20; i++) trust.service.limiter.charge("people.find", "u-me");
    await expect(as("u-me").people.find({ query: "@irfan" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "You're looking people up very quickly. Try again in a minute.",
    });
    // Somebody else's budget is their own.
    await expect(as("u-irf").people.find({ query: "@dominion" })).resolves.toMatchObject({ kind: "handle" });
  });

  test("a lookup is a mutation only to keep the query out of URLs; it spends no write budget", () => {
    expect(READ_ONLY_MUTATIONS.has("people.find")).toBe(true);
    const procedures = callsRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>;
    expect(procedures["people.find"]!._def.type).toBe("mutation");
  });

  test("the strict input takes nothing but the query", async () => {
    const h = scene();
    const { as } = await routes(h);
    await expect(
      as("u-me").people.find({ query: "@irfan", viewerUserId: "u-irf" } as unknown as { query: string }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("findPerson read-through", () => {
  function deps(store: InMemoryCallsStore, extra: Partial<Parameters<typeof findPerson>[0]> = {}) {
    const rt = buildCallsRuntime(undefined, { store });
    return {
      store,
      people: rt.service.people,
      identities: identities(),
      xAvatars: avatars(),
      clock: { now: () => 1, sleep: async () => {} },
      ...extra,
    };
  }

  test("an account made after boot is read through by @username and by id", async () => {
    const store = new InMemoryCallsStore();
    store.upsertPerson(person("u-me"));
    const readHandles: string[] = [];
    const readIds: string[] = [];
    const found = await findPerson(
      deps(store, {
        identities: identities({ x: [{ userId: "u-newx", xHandle: "newx", xAvatarUrl: null, seenAt: 1 }] }),
        refreshByHandle: async (handle) => {
          readHandles.push(handle);
          store.upsertPerson(person("u-new", { handle: "newbie" }));
        },
        refreshById: async (id) => {
          readIds.push(id);
          store.upsertPerson(person(id, { handle: "fresh_x" }));
        },
      }),
      parseFindQuery("@newbie")!,
      "u-me",
    );
    expect(readHandles).toEqual(["newbie"]);
    expect(found.matches.map((m) => m.person.id)).toEqual(["u-new"]);

    const byX = await findPerson(
      deps(store, {
        identities: identities({ x: [{ userId: "u-newx", xHandle: "newx", xAvatarUrl: null, seenAt: 1 }] }),
        refreshById: async (id) => {
          readIds.push(id);
          store.upsertPerson(person(id, { handle: "fresh_x" }));
        },
      }),
      parseFindQuery("x.com/newx")!,
      "u-me",
    );
    expect(readIds).toEqual(["u-newx"]);
    expect(byX.matches.map((m) => [m.person.id, m.xHandle])).toEqual([["u-newx", "newx"]]);
  });

  test("a read-through that fails fails the lookup", async () => {
    const store = new InMemoryCallsStore();
    store.upsertPerson(person("u-me"));
    await expect(
      findPerson(
        deps(store, {
          refreshByHandle: async () => {
            throw new Error("database unavailable");
          },
        }),
        parseFindQuery("@someone")!,
        "u-me",
      ),
    ).rejects.toThrow("database unavailable");
  });

  test("never more than three matches", async () => {
    const store = new InMemoryCallsStore();
    store.upsertPerson(person("u-me"));
    const x: XIdentity[] = [];
    for (let i = 0; i < 6; i++) {
      store.upsertPerson(person(`u-${i}`));
      x.push({ userId: `u-${i}`, xHandle: "same", xAvatarUrl: null, seenAt: 10 - i });
    }
    const found = await findPerson(deps(store, { identities: identities({ x }) }), parseFindQuery("x.com/same")!, "u-me");
    expect(found.matches.map((m) => m.person.id)).toEqual(["u-0", "u-1", "u-2"]);
  });

  test("an in-memory runtime has no X sign-ins and asks unavatar for nothing", async () => {
    const rt = buildCallsRuntime(undefined, { store: new InMemoryCallsStore() });
    expect(await rt.identities.byXHandle("irfan")).toEqual([]);
    expect(await rt.xAvatars.avatarFor("irfan")).toBeNull();
  });
});
