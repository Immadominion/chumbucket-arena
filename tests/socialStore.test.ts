import { describe, expect, test } from "bun:test";
import { SupabaseSocialStore } from "../src/social/SocialStore.ts";

describe("SupabaseSocialStore", () => {
  test("records prediction calls through the PostgREST RPC shape", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify("position-1"), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const store = new SupabaseSocialStore(
      {
        supabaseUrl: "https://example.supabase.co/",
        serviceRoleKey: "service-role",
        network: "devnet",
      },
      fetchImpl as typeof fetch,
    );

    const result = await store.recordPredictionCall({
      wallet: "wallet123",
      matchId: "fixture-1",
      marketId: "RESULT",
      bucket: "HOME",
      stakeBaseUnits: "1000000",
      txSignature: "sig123",
      metadata: { home: "A", away: "B" },
    });

    expect(result).toEqual({ ok: true, positionId: "position-1" });
    expect(requests.length).toBe(1);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/record_prediction_call");
    expect(requests[0]!.init?.method).toBe("POST");
    expect((requests[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer service-role");
    expect(JSON.parse(requests[0]!.init?.body as string)).toEqual({
      p_network: "devnet",
      p_wallet_address: "wallet123",
      p_match_id: "fixture-1",
      p_market_id: "RESULT",
      p_bucket: "HOME",
      p_stake_base_units: "1000000",
      p_tx_signature: "sig123",
      p_position_address: null,
      p_slot: null,
      p_metadata: { home: "A", away: "B" },
    });
  });

  test("confirms prediction signatures through an idempotent RPC", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ positionsUpdated: 1, activityUpdated: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const store = new SupabaseSocialStore(
      {
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "service-role",
        network: "devnet",
      },
      fetchImpl as typeof fetch,
    );

    const result = await store.confirmPredictionSignature({
      source: "helius",
      txSignature: "sig123",
      slot: 42,
      payload: { type: "ENHANCED_TRANSACTION" },
    });

    expect(result.ok).toBe(true);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/confirm_prediction_signature");
    expect(JSON.parse(requests[0]!.init?.body as string)).toEqual({
      p_network: "devnet",
      p_source: "helius",
      p_tx_signature: "sig123",
      p_slot: 42,
      p_payload: { type: "ENHANCED_TRANSACTION" },
    });
  });

  test("queries positions with wallet and network filters", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify([]), { status: 200 });
    };
    const store = new SupabaseSocialStore(
      {
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "service-role",
        network: "mainnet-beta",
      },
      fetchImpl as typeof fetch,
    );

    await store.myPositions("wallet123", 25);

    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/rest/v1/prediction_positions");
    expect(url.searchParams.get("network")).toBe("eq.mainnet-beta");
    expect(url.searchParams.get("wallet_address")).toBe("eq.wallet123");
    expect(url.searchParams.get("order")).toBe("placed_at.desc");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  function rpcCapture(response: unknown) {
    const requests: { url: string; body: unknown }[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    };
    const store = new SupabaseSocialStore(
      { supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role", network: "devnet" },
      fetchImpl as typeof fetch,
    );
    return { store, requests };
  }

  test("follow calls the follow_wallet RPC with the right shape", async () => {
    const { store, requests } = rpcCapture({ id: "f1", following: true });
    const r = await store.follow("follower1", "followee1");
    expect(r.ok).toBe(true);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/follow_wallet");
    expect(requests[0]!.body).toEqual({ p_network: "devnet", p_follower: "follower1", p_followee: "followee1" });
  });

  test("followingFeed calls feed_following and returns the rows", async () => {
    const { store, requests } = rpcCapture([{ id: "a1" }]);
    const rows = await store.followingFeed("wallet1", 30);
    expect(rows.length).toBe(1);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/feed_following");
    expect(requests[0]!.body).toEqual({ p_network: "devnet", p_wallet: "wallet1", p_limit: 30 });
  });

  test("socialLeaderboard calls social_leaderboard with by/limit", async () => {
    const { store, requests } = rpcCapture([]);
    await store.socialLeaderboard("winrate", 10);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/social_leaderboard");
    expect(requests[0]!.body).toEqual({ p_by: "winrate", p_limit: 10 });
  });

  test("createPendingTarget calls create_pending_target with the right shape and returns its result", async () => {
    const { store, requests } = rpcCapture({ id: "pt-1", resolvedWalletAddress: null, alreadyResolved: false });
    const r = await store.createPendingTarget("wallet1", "twitter", "satoshi");
    expect(r).toEqual({ id: "pt-1", resolvedWalletAddress: null, alreadyResolved: false });
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/create_pending_target");
    expect(requests[0]!.body).toEqual({
      p_network: "devnet",
      p_wallet: "wallet1",
      p_provider: "twitter",
      p_provider_username: "satoshi",
    });
  });

  // decode() can hand back `null` for a SQL-NULL RPC response — both real
  // clients would otherwise crash on it (web reads `.alreadyResolved` off a
  // null; mobile's `fromJson` casts a null to `Map<String, dynamic>`), so the
  // store must fail loudly here instead of passing the null through.
  test("createPendingTarget throws on a null/malformed RPC response instead of returning it", async () => {
    const { store } = rpcCapture(null);
    await expect(store.createPendingTarget("wallet1", "twitter", "satoshi")).rejects.toThrow(
      /create_pending_target returned an unexpected response/,
    );
  });

  test("pendingTargets calls pending_targets_for_wallet and returns the rows", async () => {
    const row = {
      id: "pt-1",
      network: "devnet",
      provider: "twitter",
      provider_username: "satoshi",
      created_by_wallet: "wallet1",
      target_type: "follow",
      target_ref: null,
      resolved_wallet_address: null,
      created_at: "2026-07-19T00:00:00Z",
      resolved_at: null,
    };
    const { store, requests } = rpcCapture([row]);
    const rows = await store.pendingTargets("wallet1", 25);
    expect(rows).toEqual([row]);
    expect(requests[0]!.url).toBe("https://example.supabase.co/rest/v1/rpc/pending_targets_for_wallet");
    expect(requests[0]!.body).toEqual({ p_network: "devnet", p_wallet: "wallet1", p_limit: 25 });
  });

  function store(fetchImpl: unknown) {
    return new SupabaseSocialStore(
      { supabaseUrl: "https://ex.supabase.co", serviceRoleKey: "svc", network: "devnet" },
      fetchImpl as typeof fetch,
    );
  }

  test("verifyOAuthUser extracts a Google identity from GoTrue /auth/v1/user", async () => {
    const user = {
      id: "u1",
      email: "a@b.com",
      identities: [
        { provider: "google", id: "g1", identity_data: { sub: "google-sub-1", name: "Alice A", picture: "http://av/a.png", email: "a@b.com" } },
      ],
    };
    const s = store(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://ex.supabase.co/auth/v1/user");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
      return new Response(JSON.stringify(user), { status: 200 });
    });
    expect(await s.verifyOAuthUser("tok123")).toMatchObject({
      provider: "google",
      subject: "google-sub-1",
      displayName: "Alice A",
      avatarUrl: "http://av/a.png",
      email: "a@b.com",
    });
  });

  test("verifyOAuthUser extracts an X identity (user_name -> username) and returns null on 401", async () => {
    const xUser = {
      id: "u2",
      identities: [{ provider: "twitter", id: "t1", identity_data: { sub: "x-sub-1", user_name: "satoshi", name: "Satoshi", avatar_url: "http://av/x.png" } }],
    };
    let ok = true;
    const s = store(async () => (ok ? new Response(JSON.stringify(xUser), { status: 200 }) : new Response("", { status: 401 })));
    expect(await s.verifyOAuthUser("t")).toMatchObject({ provider: "twitter", subject: "x-sub-1", username: "satoshi", displayName: "Satoshi" });
    ok = false;
    expect(await s.verifyOAuthUser("bad")).toBeNull();
  });
});
