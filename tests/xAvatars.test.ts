/**
 * Public X pictures for the add-a-friend card (src/calls/xAvatars.ts) and the
 * Postgres identity reader behind people.find (src/calls/identityReader.ts).
 *
 * No test reaches the network: every fetch is injected.
 */

import { describe, expect, test } from "bun:test";
import { SupabasePersonIdentityReader } from "../src/calls/identityReader.ts";
import {
  resolveXAvatarConfig,
  safeXAvatarUrl,
  UnavatarXAvatarLookup,
  X_AVATAR_TTL,
  type XAvatarConfig,
} from "../src/calls/xAvatars.ts";
import { isPgrestError } from "../src/prediction/pgrest.ts";

describe("safeXAvatarUrl", () => {
  test("X's own image hosts over https only, at a card-sized variant", () => {
    expect(safeXAvatarUrl("https://pbs.twimg.com/profile_images/1539712094/photo_normal.jpg")).toBe(
      "https://pbs.twimg.com/profile_images/1539712094/photo_400x400.jpg",
    );
    expect(safeXAvatarUrl("https://pbs.twimg.com/profile_images/1539712094/photo_200x200.JPG")).toBe(
      "https://pbs.twimg.com/profile_images/1539712094/photo_200x200.JPG",
    );
    expect(safeXAvatarUrl("https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png")).toBe(
      "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
    );
  });

  test("anything else is null", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "",
      "http://pbs.twimg.com/profile_images/1/a.jpg",
      "https://evil.example/profile_images/1/a.jpg",
      "https://pbs.twimg.com.evil.example/a.jpg",
      "https://user:pw@pbs.twimg.com/a.jpg",
      "https://pbs.twimg.com:444/a.jpg",
      "javascript:alert(1)",
      "assets/images/ai_gen/profile_images/1.png",
      `https://pbs.twimg.com/${"a".repeat(600)}`,
    ]) {
      expect(safeXAvatarUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("resolveXAvatarConfig", () => {
  test("on by default with a free-tier budget; a key raises it; off switches it off", () => {
    expect(resolveXAvatarConfig({})).toMatchObject({ enabled: true, apiKey: null, lookupsPerDay: 20 });
    expect(resolveXAvatarConfig({ UNAVATAR_API_KEY: "uk_live_abcdefgh" })).toMatchObject({
      enabled: true,
      lookupsPerDay: 2000,
    });
    expect(resolveXAvatarConfig({ X_AVATAR_LOOKUP: "off" }).enabled).toBe(false);
    expect(resolveXAvatarConfig({ X_AVATAR_LOOKUPS_PER_DAY: "5" }).lookupsPerDay).toBe(5);
    expect(resolveXAvatarConfig({ X_AVATAR_LOOKUPS_PER_DAY: "lots" }).lookupsPerDay).toBe(20);
  });
});

describe("UnavatarXAvatarLookup", () => {
  const PIC = "https://pbs.twimg.com/profile_images/1539712094/photo_200x200.JPG";

  function lookup(
    respond: (url: URL, init: RequestInit) => Response | Promise<Response>,
    config: Partial<XAvatarConfig> = {},
  ) {
    let now = 1_760_000_000_000;
    const seen: { url: URL; init: RequestInit }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    }) as unknown as typeof fetch;
    const subject = new UnavatarXAvatarLookup({
      config: { enabled: true, apiKey: null, lookupsPerDay: 20, timeoutMs: 2500, ...config },
      fetchImpl,
      now: () => now,
    });
    return { subject, seen, advance: (ms: number) => (now += ms), at: () => now };
  }

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  test("asks unavatar's JSON mode, with no fallback picture, and returns X's own URL", async () => {
    const t = lookup(() => json({ url: PIC }));
    expect(await t.subject.avatarFor("Irfan")).toBe(PIC);
    expect(t.seen).toHaveLength(1);
    const { url, init } = t.seen[0]!;
    expect(url.origin).toBe("https://unavatar.io");
    expect(url.pathname).toBe("/x/irfan");
    expect(url.searchParams.has("json")).toBe(true);
    expect(url.searchParams.get("fallback")).toBe("false");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("answers are cached: a picture for a day, 'none' for six hours", async () => {
    const t = lookup((url) => (url.pathname === "/x/irfan" ? json({ url: PIC }) : new Response("", { status: 404 })));
    expect(await t.subject.avatarFor("irfan")).toBe(PIC);
    expect(await t.subject.avatarFor("IRFAN")).toBe(PIC);
    expect(await t.subject.avatarFor("ghost")).toBeNull();
    expect(await t.subject.avatarFor("ghost")).toBeNull();
    expect(t.seen).toHaveLength(2);
    t.advance(X_AVATAR_TTL.none + 1);
    expect(await t.subject.avatarFor("ghost")).toBeNull();
    expect(await t.subject.avatarFor("irfan")).toBe(PIC);
    expect(t.seen).toHaveLength(3);
    t.advance(X_AVATAR_TTL.found);
    await t.subject.avatarFor("irfan");
    expect(t.seen).toHaveLength(4);
  });

  test("a picture off X's hosts is not a picture", async () => {
    const t = lookup(() => json({ url: "https://unavatar.io/fallback.png" }));
    expect(await t.subject.avatarFor("someone")).toBeNull();
  });

  test("a failure is null, retried after ten minutes", async () => {
    let fail = true;
    const t = lookup(() => {
      if (fail) throw new Error("timeout");
      return json({ url: PIC });
    });
    expect(await t.subject.avatarFor("irfan")).toBeNull();
    expect(await t.subject.avatarFor("irfan")).toBeNull();
    expect(t.seen).toHaveLength(1);
    fail = false;
    t.advance(X_AVATAR_TTL.failed + 1);
    expect(await t.subject.avatarFor("irfan")).toBe(PIC);
  });

  test("a 429 pauses every lookup until unavatar's reset", async () => {
    const t = lookup(() => new Response("", { status: 429 }));
    const reset = t.at() + 3_600_000;
    const limited = lookup(() => new Response("", { status: 429, headers: { "x-rate-limit-reset": String(reset) } }));
    expect(await limited.subject.avatarFor("a")).toBeNull();
    expect(await limited.subject.avatarFor("b")).toBeNull();
    expect(limited.seen).toHaveLength(1);
    limited.advance(3_600_001);
    await limited.subject.avatarFor("c");
    expect(limited.seen).toHaveLength(2);
    // No reset header: an hour.
    expect(await t.subject.avatarFor("a")).toBeNull();
    t.advance(59 * 60 * 1000);
    await t.subject.avatarFor("b");
    expect(t.seen).toHaveLength(1);
  });

  test("a daily budget stops asking before unavatar has to refuse", async () => {
    const t = lookup(() => json({ url: PIC }), { lookupsPerDay: 2 });
    expect(await t.subject.avatarFor("one")).toBe(PIC);
    expect(await t.subject.avatarFor("two")).toBe(PIC);
    expect(await t.subject.avatarFor("three")).toBeNull();
    expect(t.seen).toHaveLength(2);
    // Cached answers cost nothing.
    expect(await t.subject.avatarFor("one")).toBe(PIC);
    t.advance(24 * 60 * 60 * 1000 + 1);
    expect(await t.subject.avatarFor("three")).toBe(PIC);
  });

  test("concurrent asks for one handle share one request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = lookup(async () => {
      await gate;
      return json({ url: PIC });
    });
    const both = Promise.all([t.subject.avatarFor("irfan"), t.subject.avatarFor("Irfan")]);
    release();
    expect(await both).toEqual([PIC, PIC]);
    expect(t.seen).toHaveLength(1);
  });

  test("an optional key travels as a header only; off and invalid handles ask nothing", async () => {
    const keyed = lookup(() => json({ url: PIC }), { apiKey: "uk_live_secretvalue" });
    await keyed.subject.avatarFor("irfan");
    const { url, init } = keyed.seen[0]!;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("uk_live_secretvalue");
    expect(url.toString()).not.toContain("uk_live_secretvalue");

    const off = lookup(() => json({ url: PIC }), { enabled: false });
    expect(await off.subject.avatarFor("irfan")).toBeNull();
    for (const bad of ["", "has space", "../etc", "way_too_long_handle", "a/b"]) {
      expect(await keyed.subject.avatarFor(bad)).toBeNull();
    }
    expect(off.seen).toHaveLength(0);
    expect(keyed.seen).toHaveLength(1);
  });
});

describe("SupabasePersonIdentityReader", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";

  function reader(respond: (name: string, body: Record<string, unknown>) => Response) {
    const seen: { name: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const name = url.pathname.replace("/rest/v1/rpc/", "");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      seen.push({ name, body, headers: init?.headers as Record<string, string> });
      return respond(name, body);
    }) as unknown as typeof fetch;
    return {
      seen,
      reader: new SupabasePersonIdentityReader(
        { supabaseUrl: "https://db.test.invalid", serviceRoleKey: "sk_test_service_role" },
        fetchImpl,
      ),
    };
  }
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  test("by handle: one row per person, most recently seen first, shapes re-checked", async () => {
    const r = reader(() =>
      ok([
        { user_id: A, x_username: "Irfan", x_avatar_url: "https://pbs.twimg.com/profile_images/1/a_normal.jpg", seen_at: "2026-09-01T00:00:00Z" },
        { user_id: B, x_username: "irfan", x_avatar_url: "https://evil.example/a.jpg", seen_at: "2026-10-01T00:00:00Z" },
        { user_id: "not-a-uuid", x_username: "irfan", x_avatar_url: null, seen_at: null },
        { user_id: A, x_username: "irfan", x_avatar_url: null, seen_at: null },
        { user_id: "33333333-3333-4333-8333-333333333333", x_username: "has space", x_avatar_url: null, seen_at: null },
      ]),
    );
    const found = await r.reader.byXHandle("Irfan");
    expect(r.seen[0]).toMatchObject({ name: "person_x_identities_v2", body: { p_x_handle: "irfan", p_user_ids: null } });
    expect(found).toEqual([
      { userId: B, xHandle: "irfan", xAvatarUrl: null, seenAt: Date.parse("2026-10-01T00:00:00Z") },
      {
        userId: A,
        xHandle: "Irfan",
        xAvatarUrl: "https://pbs.twimg.com/profile_images/1/a_400x400.jpg",
        seenAt: Date.parse("2026-09-01T00:00:00Z"),
      },
    ]);
  });

  test("by ids: canonical ids only, at most fifty, nobody unasked-for", async () => {
    const r = reader(() => ok([{ user_id: A, x_username: "a", x_avatar_url: null, seen_at: null }, { user_id: B, x_username: "b" }]));
    const ids = [A, "u-not-canonical", ...Array.from({ length: 60 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`)];
    const found = await r.reader.xIdentitiesOf(ids);
    const sent = r.seen[0]!.body.p_user_ids as string[];
    expect(sent).toHaveLength(50);
    expect(sent[0]).toBe(A);
    expect(sent).not.toContain("u-not-canonical");
    expect(found.map((x) => x.userId)).toEqual([A]);
    expect(await r.reader.xIdentitiesOf(["nope"])).toEqual([]);
    expect(r.seen).toHaveLength(1);
  });

  test("before 20261004120000 (no v2): v1, remembered", async () => {
    const r = reader((name) =>
      name === "person_x_identities_v2"
        ? new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404 })
        : ok([{ user_id: A, x_username: "irfan", x_avatar_url: null, seen_at: null }]),
    );
    expect((await r.reader.byXHandle("irfan")).map((x) => x.userId)).toEqual([A]);
    expect((await r.reader.byXHandle("irfan")).map((x) => x.userId)).toEqual([A]);
    expect(r.seen.map((s) => s.name)).toEqual(["person_x_identities_v2", "person_x_identities_v1", "person_x_identities_v1"]);
  });

  test("a wallet: the person's canonical id, or null", async () => {
    const r = reader((_, body) => ok(body.p_wallet === "W1" ? A : null));
    expect(await r.reader.personForWallet("W1")).toBe(A);
    expect(await r.reader.personForWallet("W2")).toBeNull();
    expect(r.seen.map((s) => s.name)).toEqual(["person_for_wallet_v1", "person_for_wallet_v1"]);
  });

  test("failures are thrown, never 'nobody' — and never carry the key", async () => {
    const r = reader(() =>
      new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function public.person_x_identities_v1" }), {
        status: 404,
      }),
    );
    const err = await r.reader.byXHandle("irfan").catch((e: unknown) => e);
    expect(isPgrestError(err)).toBe(true);
    expect(String((err as Error).message)).not.toContain("sk_test_service_role");
    await expect(r.reader.personForWallet("W1")).rejects.toThrow();
    // The key travels in headers, as for every service-role call.
    expect(r.seen[0]!.headers.Authorization).toBe("Bearer sk_test_service_role");
  });
});
